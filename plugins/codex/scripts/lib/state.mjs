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
const BROKER_STATE_FILE_NAME = "broker.json";
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
const SCRATCH_SANDBOX_TRASH_DIR_NAME = "scratch-trash";
const SCRATCH_SANDBOX_LOCK_FILE_NAME = "scratch.lock";
export const DEFAULT_SCRATCH_SANDBOX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SCRATCH_SANDBOX_LOCK_POLL_INTERVAL_MS = 2000;
export const UNREPORTED_PROCESS_EXIT_MESSAGE = "Process exited without reporting.";
const WORKER_PROCESS_EXIT_REASON = "worker-process-exited";
const BROKER_RESTARTED_WORKER_GONE_REASON = "broker-restarted-worker-gone";

function nowIso() {
  return new Date().toISOString();
}

export function isDeadWorkerFailure(job) {
  return (
    job?.status === "failed" &&
    (job.failureReason === WORKER_PROCESS_EXIT_REASON ||
      job.failureReason === BROKER_RESTARTED_WORKER_GONE_REASON ||
      job.errorMessage === UNREPORTED_PROCESS_EXIT_MESSAGE)
  );
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

// The root all per-workspace state directories live under: `<CLAUDE_PLUGIN_DATA>/state`
// when the plugin host provides one, otherwise a fixed fallback under the OS
// temp directory. Exported as its own function (not just inlined in
// resolveStateDir) because the scratch-sandbox path-safety checks need to
// walk from exactly this root down to a given stateDir — see
// assertScratchDirIsSafeToTouch.
function resolvePluginDataStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
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
  return path.join(resolvePluginDataStateRoot(), `${slug}-${hash}`);
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

// `assertPathIsPlainDescendant(stateDir, scratchDir)` alone only walks the
// path BELOW stateDir (i.e. the single "scratch" segment) — it never lstats
// stateDir itself. If stateDir's own slot on disk were a junction pointing
// somewhere that already happens to contain a "scratch" subdirectory, that
// check would pass while every subsequent read/write/delete actually landed
// in the junction's target, not in the plugin's real state directory
// (code-review finding CRITICAL #1, second round). So this also walks from
// the plugin's data root (resolvePluginDataStateRoot — CLAUDE_PLUGIN_DATA's
// `state` subdirectory, or the tmp fallback) down to and INCLUDING stateDir
// itself: `assertPathIsPlainDescendant`'s segment loop lstats every
// accumulated path, and the final segment IS `to`, so this covers stateDir.
// Above the data root is out of scope by design — see the threat-model note
// on resetScratchSandboxDir below.
function assertScratchDirIsSafeToTouch(stateDir, scratchDir, repoCwd) {
  assertPathIsPlainDescendant(resolvePluginDataStateRoot(), stateDir);
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
//
// THREAT MODEL, and what is deliberately NOT closed here (code-review
// finding CRITICAL #2, second round — TOCTOU between the second check above
// and the readdir/rm loop below):
//   - From INSIDE the sandboxed Codex turn itself, the only writable root is
//     the scratch directory (see buildThreadConfigOverrides in
//     lib/codex.mjs) — the path components ABOVE scratch (stateDir and its
//     ancestors up to the plugin data root) are outside every writable root,
//     so a process running inside that sandbox cannot replace any of them
//     with a junction. It also cannot escape the race by racing this
//     specific window, because it cannot touch that part of the path at
//     all, at any point in time.
//   - A junction placed INSIDE scratch itself (i.e. one of the entries the
//     readdir/rm loop below iterates over) is not a problem either:
//     `fs.rmSync(..., { recursive: true })` lstats each path it recurses
//     into, so a junction encountered AS AN ENTRY is deleted as the link
//     itself, without ever being dereferenced into (and deleting) its
//     target — see the "resetScratchSandboxDir does not follow a junction
//     placed directly inside scratch when clearing it" test.
//   - The remaining gap is a race on the path components ABOVE scratch
//     between the check on the line above and the loop below, but the only
//     party who could win that race is another process running as the SAME
//     OS user OUTSIDE the sandbox — and that process already has unrestricted
//     filesystem access (it can delete or replace anything on disk directly,
//     sandboxed Codex run or not). Closing this specific TOCTOU window would
//     not remove any capability such a process doesn't already have, so it
//     is out of scope: the check exists to fail closed against a
//     MISCONFIGURATION (a data root that resolves through a junction) and
//     against the sandboxed Codex process, not against an unsandboxed
//     co-resident process racing the filesystem.
//
// UNDELETABLE LEFTOVERS. On Windows the sandboxed turn runs as a separate
// local user (CodexSandboxOffline), and Python >= 3.13 turns
// `os.mkdir(path, 0o700)` — which is how pytest creates its basetemp — into
// a PROTECTED DACL of SYSTEM, Administrators and CREATOR OWNER only. Such a
// directory inherits nothing from scratch, its owner is the sandbox user,
// and the host user can neither delete it nor even rename it inside scratch
// (both EPERM, verified on a real leftover `scratch/pytest-temp2`). What the
// host user CAN do is rename the scratch directory itself — scratch's own
// ACL, inherited from the state dir, still grants it full control. So a
// leftover that will not go away must not fail the whole job: the entire
// scratch directory is moved aside to `scratch-trash/<timestamp>` and a
// fresh one is created. That costs Codex one new writable-root SID on this
// rare path (see SCRATCH_SANDBOX_DIR_NAME), which is the lesser evil
// compared to a job that cannot start at all. Old trash is garbage-collected
// best effort on every call; what stays undeletable is reported via `warn`
// together with the command that clears it as an administrator.
export function resetScratchSandboxDir(cwd, { warn = null } = {}) {
  const stateDir = resolveStateDir(cwd);
  const dir = resolveScratchSandboxDir(cwd);
  const trashDir = path.join(stateDir, SCRATCH_SANDBOX_TRASH_DIR_NAME);
  const report = (message) => warn?.(message);
  assertScratchDirIsSafeToTouch(stateDir, dir, cwd);
  fs.mkdirSync(dir, { recursive: true });

  collectScratchTrash(stateDir, trashDir, cwd, report);

  assertScratchDirIsSafeToTouch(stateDir, dir, cwd);
  const stuck = [];
  for (const entry of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch (error) {
      stuck.push({ entry, code: error?.code ?? "unknown error" });
    }
  }
  if (stuck.length === 0) {
    return dir;
  }

  const stuckList = stuck.map(({ entry, code }) => `${entry} (${code})`).join(", ");
  assertPathIsPlainDescendant(stateDir, trashDir);
  const parked = path.join(trashDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(dir, parked);
    fs.mkdirSync(dir);
  } catch (error) {
    // Could not move scratch aside either (e.g. a still-running process
    // from the previous turn holds a handle inside it). The leftovers are
    // the same repository's own previous-run artifacts, so starting on top
    // of them is safer than not starting — but say so.
    fs.mkdirSync(dir, { recursive: true });
    report(
      `scratch sandbox: could not remove ${stuckList} from ${dir} and could not move the directory aside (${error?.code ?? error}); ` +
        `the run starts with these leftovers in place.`
    );
    return dir;
  }
  report(
    `scratch sandbox: could not remove ${stuckList} (created by the Codex sandbox user with owner-only permissions); ` +
      `moved the old scratch directory to ${parked} and started with a fresh one.`
  );
  return dir;
}

// Best-effort removal of scratch directories parked by resetScratchSandboxDir.
// Never throws for an entry that will not go away — that is exactly the case
// the trash exists for — only reports it, once per call.
function collectScratchTrash(stateDir, trashDir, repoCwd, report) {
  if (!fs.existsSync(trashDir)) {
    return;
  }
  assertPathIsPlainDescendant(stateDir, trashDir);
  assertNotInsideRepo(trashDir, repoCwd, "the scratch trash directory");
  const stuck = [];
  for (const entry of fs.readdirSync(trashDir)) {
    try {
      fs.rmSync(path.join(trashDir, entry), { recursive: true, force: true });
    } catch {
      stuck.push(entry);
    }
  }
  if (stuck.length > 0) {
    report(
      `scratch sandbox: ${stuck.length} parked scratch director${stuck.length === 1 ? "y" : "ies"} in ${trashDir} still cannot be deleted by this user; ` +
        `to clear them, from an elevated prompt run: takeown /f "${trashDir}" /r /a, then icacls "${trashDir}" /grant *S-1-5-32-544:F /t, then rmdir /s /q "${trashDir}"`
    );
  }
}

function resolveScratchSandboxLockFile(cwd) {
  return path.join(resolveStateDir(cwd), SCRATCH_SANDBOX_LOCK_FILE_NAME);
}

function readScratchSandboxLockOwner(lockFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return {
      pid: Number.isInteger(raw?.pid) ? raw.pid : null,
      jobId: typeof raw?.jobId === "string" ? raw.jobId : null,
      startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : null
    };
  } catch {
    return { pid: null, jobId: null, startedAt: null };
  }
}

function writeScratchSandboxLock(lockFile, jobId) {
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, jobId: jobId ?? null, startedAt: nowIso() }),
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
      // else, which should not happen but must not throw out of a cleanup
      // path either way) is not an error here.
    }
  };
}

// A lock is stale — safe to reclaim without waiting out the poll timeout —
// under any of three conditions (code-review finding IMPORTANT #4, second
// round): its pid is dead (the original check); its recorded jobId names a
// job that has already reached a TERMINAL status in this repository's job
// index (completed/failed/cancelled — the process is alive but is no longer
// the one that held this lock, e.g. an OS pid reused after the original
// holder exited); or its jobId is not in the index at all (the job record
// was pruned or never existed). A lock with no jobId (a foreign/corrupt
// lock file) can only be judged by pid liveness.
//
// Deliberately NOT covered — see resetScratchSandboxDir's threat-model note
// for the equivalent tradeoff on path safety: a worker that dies mid-run in
// a way that leaves its job record stuck "running" (an orphaned log without
// the job index itself being reconciled — reconcileRunningJobs handles the
// job's OWN status but runs on a different read path than this lock check)
// is not detected as stale by the jobId rule, only by the pid-liveness rule
// once that pid is actually gone. The consequence is bounded: the next
// `--scratch-sandbox` job on this repository waits out the lock timeout and
// then fails with a clear "busy with job <id>" error — it does not corrupt
// anything or write to the repository, it just has to be retried.
function isScratchSandboxLockStale(owner, cwd) {
  if (!owner.pid || !isProcessAlive(owner.pid)) {
    return true;
  }
  if (!owner.jobId) {
    return false;
  }
  const job = loadState(cwd).jobs.find((candidate) => candidate.id === owner.jobId);
  if (!job) {
    return true;
  }
  return TERMINAL_JOB_STATUSES.has(job.status);
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
// or go stale (see isScratchSandboxLockStale) — a stale lock is reclaimed
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
      return writeScratchSandboxLock(lockFile, jobId);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const owner = readScratchSandboxLockOwner(lockFile);
    if (isScratchSandboxLockStale(owner, cwd)) {
      // Test-only instrumentation: widens the window between deciding a
      // lock is stale and acting on that decision, so
      // tests/scratch-lock-race-child.mjs can deterministically reproduce
      // (rather than rely on incidental OS-scheduler timing for) the
      // takeover-identity race the verification a few lines below this
      // guards against. Never set outside that test.
      const debugDelayMs = Number(process.env.CODEX_COMPANION_SCRATCH_LOCK_DEBUG_DELAY_MS);
      if (Number.isFinite(debugDelayMs) && debugDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, debugDelayMs));
      }
      // Atomic takeover, not a plain unlink-then-create: two processes can
      // both observe the same stale lock at once (code-review finding
      // IMPORTANT #3, second round). Renaming the stale file to a unique
      // staging name is the atomic step a filesystem actually guarantees —
      // exactly one renamer succeeds; every other racer's renameSync gets
      // ENOENT (the source is already gone) and falls through to retry from
      // the top of the loop, where it will either see our fresh lock (EEXIST
      // on its own `wx` attempt) or — if we have not written it yet — race
      // for the `wx` create itself, which is likewise exclusive.
      const staleTarget = `${lockFile}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      let renamed = false;
      try {
        fs.renameSync(lockFile, staleTarget);
        renamed = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      if (renamed) {
        // renameSync itself does not check WHAT it moved — only that
        // something existed at lockFile. If enough time passed between
        // reading `owner` above and this rename (a live OS scheduler
        // preemption, not just the couple of machine instructions between
        // this rename and the write below), a DIFFERENT process could have
        // already legitimately reclaimed the very same stale lock and
        // published its own fresh one at lockFile in between — and this
        // rename would have just carried THAT fresh, active lock away, not
        // the stale one we inspected. Verify identity against what we
        // renamed before trusting the takeover: if it does not match, put
        // it back (best-effort) and fall through to retry instead of
        // treating someone else's live lock as ours to overwrite.
        const movedOwner = readScratchSandboxLockOwner(staleTarget);
        const staleTakeoverMismatched =
          movedOwner.pid !== owner.pid || movedOwner.jobId !== owner.jobId || movedOwner.startedAt !== owner.startedAt;
        if (staleTakeoverMismatched) {
          try {
            fs.renameSync(staleTarget, lockFile);
          } catch {
            // Best-effort: if putting it back fails (e.g. a third racer's
            // own fresh lock already occupies lockFile again by now), the
            // legitimate holder's OWN lock file is not what we are holding
            // here — nothing more we can safely do. staleTarget is left
            // behind as an inert `.stale-<pid>-<rand>` relic either way.
          }
          continue;
        }
        try {
          const release = writeScratchSandboxLock(lockFile, jobId);
          try {
            fs.unlinkSync(staleTarget);
          } catch {
            // Best-effort cleanup of our own staging file — a leftover
            // `.stale-<pid>-<rand>` file is inert and never looked at again.
          }
          return release;
        } catch (writeError) {
          // Lost a further race for lockFile itself (a third process's own
          // takeover of a DIFFERENT stale lock, or a brand-new legitimate
          // acquire, landed there between our rename and our write). Clean
          // up the staging file and fall through to retry like any other
          // contention.
          try {
            fs.unlinkSync(staleTarget);
          } catch {
            // best-effort
          }
          if (writeError?.code !== "EEXIST") {
            throw writeError;
          }
        }
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

function loadCurrentBrokerEndpoint(cwd) {
  const brokerStateFile = path.join(resolveStateDir(cwd), BROKER_STATE_FILE_NAME);
  if (!fs.existsSync(brokerStateFile)) {
    return null;
  }
  try {
    const endpoint = JSON.parse(fs.readFileSync(brokerStateFile, "utf8"))?.endpoint;
    return typeof endpoint === "string" && endpoint ? endpoint : null;
  } catch {
    return null;
  }
}

function deadWorkerFailure(job, currentBrokerEndpoint) {
  if (job.brokerEndpoint && currentBrokerEndpoint && job.brokerEndpoint !== currentBrokerEndpoint) {
    return {
      failureReason: BROKER_RESTARTED_WORKER_GONE_REASON,
      errorMessage: `Broker restarted (endpoint ${job.brokerEndpoint} -> ${currentBrokerEndpoint}); worker pid ${job.pid} is gone.`
    };
  }
  return {
    failureReason: WORKER_PROCESS_EXIT_REASON,
    errorMessage: UNREPORTED_PROCESS_EXIT_MESSAGE
  };
}

function appendReconciliationLog(logFile, message) {
  if (!logFile || !message) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] Marked failed: ${message}\n`, "utf8");
  } catch {
    // Reconciliation must still persist the authoritative state when the log is unavailable.
  }
}

function reconcileRunningJobs(cwd, state) {
  const completedAt = nowIso();
  const currentBrokerEndpoint = loadCurrentBrokerEndpoint(cwd);
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

    const failure = deadWorkerFailure(job, currentBrokerEndpoint);
    const failedJob = {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      updatedAt: completedAt,
      ...failure
    };
    staleJobs.push(failedJob);
    return failedJob;
  });

  if (staleJobs.length === 0) {
    return state.jobs;
  }

  const nextState = saveState(cwd, { ...state, jobs });
  for (const job of staleJobs) {
    appendReconciliationLog(job.logFile, job.errorMessage);
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
        errorMessage: job.errorMessage,
        failureReason: job.failureReason
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
