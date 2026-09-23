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

// Create the scratch sandbox directory if missing, and otherwise clear its
// CONTENTS before a run — never delete/recreate the directory itself (that
// would hand Codex a directory it has never granted a writable root to,
// forcing Windows to mint a fresh synthetic SID; see the comment on
// SCRATCH_SANDBOX_DIR_NAME above). A previous run's leftovers must not leak
// into the next one, so this always runs before starting the sandboxed turn.
export function resetScratchSandboxDir(cwd) {
  const dir = resolveScratchSandboxDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return dir;
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
