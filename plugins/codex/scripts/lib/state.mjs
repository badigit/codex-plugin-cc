import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
// `task --scratch-sandbox` writable-away-from-the-repo directory. Deliberately
// a FIXED path per repository (same state dir the rest of this module keys by
// cwd), not a fresh mkdtemp per run: on Windows, Codex's sandbox grants a
// synthetic SID write access to each distinct writable root it sees, and that
// SID sticks around as a dangling ACE once the directory is gone (see
// tooling/codex-cli.md, cap_sid / codex-acl-gc.ps1 in the tooling repo). A
// one-shot temp dir per invocation would grow that ACL by one entry every
// run; reusing the same path lets Codex reuse the SID it already granted.
const SCRATCH_SANDBOX_DIR_NAME = "scratch";
const SCRATCH_SANDBOX_LOCK_FILE_NAME = "scratch.lock";
export const DEFAULT_SCRATCH_SANDBOX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SCRATCH_SANDBOX_LOCK_POLL_INTERVAL_MS = 2000;
export const UNREPORTED_PROCESS_EXIT_MESSAGE = "Process exited without reporting.";

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// Path only — does not create the directory. `cwd` here is always the
// REPOSITORY, never the scratch directory itself: resolveStateDir keys off
// resolveWorkspaceRoot(cwd), and the scratch directory is not (and must not
// become) a git repository.
export function resolveScratchSandboxDir(cwd) {
  return path.join(resolveStateDir(cwd), SCRATCH_SANDBOX_DIR_NAME);
}

function normalizePathForCompare(value) {
  return String(value ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function realpathOrSelf(candidate) {
  try {
    return fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : path.resolve(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isSameOrInside(candidatePath, containerPath) {
  const normalizedCandidate = normalizePathForCompare(realpathOrSelf(candidatePath));
  const normalizedContainer = normalizePathForCompare(realpathOrSelf(containerPath));
  return normalizedCandidate === normalizedContainer || normalizedCandidate.startsWith(`${normalizedContainer}/`);
}

// Walks every existing path component between `from` (exclusive) and `to`
// (inclusive) with `fs.lstatSync` — not `fs.statSync`, which would follow a
// symlink/junction instead of reporting it — and refuses if any of them is a
// reparse point (Node reports a Windows junction created via
// `fs.symlinkSync(target, link, "junction")` as `isSymbolicLink() === true`).
// A junction anywhere on this path could silently redirect a later recursive
// delete outside the scratch sandbox this function exists to police — see
// the code-review finding this guards (CRITICAL #2). Also asserts realpath
// containment as a second, independent check: some exotic reparse-point
// shapes are not guaranteed to be caught by lstat's isSymbolicLink() alone.
function assertPathIsPlainDescendant(from, to) {
  const normalizedFrom = path.resolve(from);
  const normalizedTo = path.resolve(to);
  const relative = path.relative(normalizedFrom, normalizedTo);
  if (!relative || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to treat "${to}" as the scratch sandbox directory: it is not inside "${from}".`);
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = normalizedFrom;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      continue;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(
        `Refusing to operate on "${to}": "${current}" is a symlink/junction, not a plain directory. The scratch sandbox path must not pass through a reparse point.`
      );
    }
  }

  if (!isSameOrInside(normalizedTo, normalizedFrom)) {
    throw new Error(`Refusing to operate on "${to}": its real path resolves outside "${from}".`);
  }
}

// Neither the plugin's state directory nor the scratch sandbox inside it may
// resolve into the repository the scratch sandbox exists to keep read-only —
// if either did (a misconfigured CLAUDE_PLUGIN_DATA, a repo-relative
// fallback, …), clearing "scratch" would mean clearing part of the
// repository itself.
function assertNotInsideRepo(candidatePath, repoRoot, label) {
  if (isSameOrInside(candidatePath, repoRoot)) {
    throw new Error(
      `Refusing to use ${label} "${candidatePath}": it resolves inside the repository "${repoRoot}". The scratch sandbox must live outside the repository it is meant to keep read-only.`
    );
  }
}

function assertScratchDirIsSafeToTouch(stateDir, scratchDir, repoCwd) {
  assertPathIsPlainDescendant(stateDir, scratchDir);
  assertNotInsideRepo(stateDir, repoCwd, "the plugin state directory");
  assertNotInsideRepo(scratchDir, repoCwd, "the scratch sandbox directory");
}

// Create the scratch sandbox directory if missing, and otherwise clear its
// CONTENTS before a run — never delete/recreate the directory itself (that
// would hand Codex a directory it has never granted a writable root to,
// forcing Windows to mint a fresh synthetic SID; see the comment on
// SCRATCH_SANDBOX_DIR_NAME above). A previous run's leftovers must not leak
// into the next one, so this always runs before starting the sandboxed turn.
//
// Safety checks run TWICE: once before creating the directory (cheap,
// catches a repo/state-dir misconfiguration early) and once again
// immediately before the destructive readdir/rm loop below — the second
// call is the one that actually guards that loop and must not be skipped or
// hoisted away, since nothing between the two calls may be trusted to have
// kept the directory's identity unchanged (code-review finding CRITICAL #2:
// "проверку повторять непосредственно перед самой очисткой").
export function resetScratchSandboxDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const dir = resolveScratchSandboxDir(cwd);
  assertScratchDirIsSafeToTouch(stateDir, dir, cwd);
  fs.mkdirSync(dir, { recursive: true });

  assertScratchDirIsSafeToTouch(stateDir, dir, cwd);
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return dir;
}

function resolveScratchSandboxLockFile(cwd) {
  return path.join(resolveStateDir(cwd), SCRATCH_SANDBOX_LOCK_FILE_NAME);
}

function readScratchSandboxLockOwner(lockFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return {
      pid: Number.isInteger(raw?.pid) ? raw.pid : null,
      jobId: typeof raw?.jobId === "string" ? raw.jobId : null
    };
  } catch {
    return { pid: null, jobId: null };
  }
}

// Serializes access to the shared, per-repository scratch sandbox directory
// across concurrent `task --scratch-sandbox` runs on the same repository —
// the directory is intentionally a FIXED path (see SCRATCH_SANDBOX_DIR_NAME
// above), so two jobs racing to clear/use it at the same time would corrupt
// each other's run (code-review finding IMPORTANT #4). Held for the whole
// "clear scratch → turn finished" interval by the caller (see
// codex-companion.mjs's executeTaskRun).
//
// Waits up to `timeoutMs` (default 10 minutes), polling every
// `pollIntervalMs` (default 2s), for the current holder to release the lock
// or die — a dead holder's lock (pid no longer alive) is reclaimed
// immediately, without waiting out the remaining timeout. Returns a release
// function; the caller MUST call it (normally from a `finally`) once done.
export async function acquireScratchSandboxLock(cwd, jobId, options = {}) {
  const lockFile = resolveScratchSandboxLockFile(cwd);
  const envTimeoutMs = Number(process.env.CODEX_COMPANION_SCRATCH_LOCK_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : Number.isFinite(envTimeoutMs) && envTimeoutMs > 0
        ? envTimeoutMs
        : DEFAULT_SCRATCH_SANDBOX_LOCK_TIMEOUT_MS;
  const envPollIntervalMs = Number(process.env.CODEX_COMPANION_SCRATCH_LOCK_POLL_INTERVAL_MS);
  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : Number.isFinite(envPollIntervalMs) && envPollIntervalMs > 0
        ? envPollIntervalMs
        : DEFAULT_SCRATCH_SANDBOX_LOCK_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  ensureStateDir(cwd);

  for (;;) {
    try {
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, jobId: jobId ?? null, createdAt: nowIso() }),
        { flag: "wx" }
      );
      return () => {
        try {
          const owner = readScratchSandboxLockOwner(lockFile);
          if (owner.pid === process.pid) {
            fs.unlinkSync(lockFile);
          }
        } catch {
          // Best-effort: a lock file already gone (or now owned by someone
          // else, which should not happen but must not throw out of a
          // cleanup path either way) is not an error here.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const owner = readScratchSandboxLockOwner(lockFile);
    if (!owner.pid || !isProcessAlive(owner.pid)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Raced with someone else already clearing the stale lock — fine,
        // just retry the acquire above.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `The scratch sandbox for this repository is busy with job ${owner.jobId ?? "unknown"} (pid ${owner.pid}). Timed out after ${timeoutMs}ms waiting for it to finish.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function reconcileRunningJobs(cwd, state) {
  const completedAt = nowIso();
  const staleJobs = [];
  const jobs = state.jobs.map((job) => {
    // "queued" also needs reconciling: enqueueBackgroundTask records the
    // detached worker's pid at enqueue time, before that worker has run far
    // enough to flip the record to "running" via runTrackedJob. A worker that
    // dies in that window (crash, immediate OOM kill) leaves the job stuck
    // "queued" forever with an already-dead pid — invisible to this check if
    // it only looked at "running" — permanently blocking --resume-last and
    // any other gate that treats queued/running as active.
    if (
      (job.status !== "running" && job.status !== "queued") ||
      !Number.isInteger(job.pid) ||
      job.pid <= 0 ||
      isProcessAlive(job.pid)
    ) {
      return job;
    }

    const failedJob = {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      updatedAt: completedAt,
      errorMessage: UNREPORTED_PROCESS_EXIT_MESSAGE
    };
    staleJobs.push(failedJob);
    return failedJob;
  });

  if (staleJobs.length === 0) {
    return state.jobs;
  }

  const nextState = saveState(cwd, { ...state, jobs });
  for (const job of staleJobs) {
    const jobFile = resolveJobFile(cwd, job.id);
    if (!fs.existsSync(jobFile)) {
      continue;
    }
    try {
      writeJobFile(cwd, job.id, {
        ...readJobFile(jobFile),
        status: job.status,
        phase: job.phase,
        pid: job.pid,
        completedAt: job.completedAt,
        errorMessage: job.errorMessage
      });
    } catch {
      // The state record is still authoritative when a per-job file is unreadable.
    }
  }
  return nextState.jobs;
}

export function listJobs(cwd) {
  const state = loadState(cwd);
  return reconcileRunningJobs(cwd, state);
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

// A background task job's persisted `request` (see codex-companion.mjs's
// enqueueBackgroundTask) can carry a fully-parsed --output-schema JSON
// Schema, kept there only so the detached worker did not have to re-read the
// file mid-run. Once the job reaches a terminal status that copy has served
// its purpose and would otherwise sit in the job file forever — but a job
// gets to a terminal status through several independent paths: a normal run
// finishing (success or failure) or crashing (tracked-jobs.mjs), `cancel`
// (codex-companion.mjs), a dead worker's stale "running"/"queued" record
// being reconciled (reconcileRunningJobs below), or the Claude session
// ending while a job is still active (session-lifecycle-hook.mjs). Every one
// of those writes the job record through writeJobFile, so sanitizing here —
// the one choke point all of them share — is what actually guarantees the
// schema is stripped everywhere, instead of relying on each call site to
// remember to do it itself. The prompt is left untouched — this only targets
// the schema — and a job NOT reaching a terminal status (queued, running, or
// restored to its previous live status after a failed cancellation attempt,
// see settleCancellationAfterTermination in job-control.mjs) is passed
// through unchanged.
function sanitizeTerminalJobRecord(payload) {
  if (
    !payload ||
    !TERMINAL_JOB_STATUSES.has(payload.status) ||
    !payload.request ||
    payload.request.outputSchema === undefined
  ) {
    return payload;
  }
  const { outputSchema, ...requestWithoutSchema } = payload.request;
  return {
    ...payload,
    request: requestWithoutSchema,
    outputSchemaUsed: true
  };
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const sanitizedPayload = sanitizeTerminalJobRecord(payload);
  fs.writeFileSync(jobFile, `${JSON.stringify(sanitizedPayload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
