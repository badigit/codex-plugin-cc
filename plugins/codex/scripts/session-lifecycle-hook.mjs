#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { isProcessAlive, terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  saveState,
  writeJobFile
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SESSION_ENDED_MESSAGE =
  "Claude session ended before the Codex turn finished; the run was stopped.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // Stop this session's still-running workers: the broker is torn down right
  // after this, so leaving them alive would only strand orphans. Everything
  // this session already produced stays on disk. Deleting the records here
  // would take their per-job result files and logs with them (saveState drops
  // the files of any job it no longer retains), so a session that ends while a
  // delegated run is finishing would destroy the very answer it was waiting
  // for — with no trace that anything was lost.
  const activeJobs = loadState(workspaceRoot).jobs.filter(
    (job) => job.sessionId === sessionId && (job.status === "queued" || job.status === "running")
  );
  if (activeJobs.length === 0) {
    return;
  }

  for (const job of activeJobs) {
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  const stoppedAt = new Date().toISOString();
  const interruptedIds = new Set(activeJobs.map((job) => job.id));
  // Re-read after termination: the worker may have written its own final state
  // between the read above and the kill, and that write must not be rolled back.
  const state = loadState(workspaceRoot);
  const stoppedJobs = [];
  const jobs = state.jobs.map((job) => {
    if (!interruptedIds.has(job.id) || (job.status !== "queued" && job.status !== "running")) {
      return job;
    }
    const stoppedJob = {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: stoppedAt,
      updatedAt: stoppedAt,
      errorMessage: SESSION_ENDED_MESSAGE
    };
    stoppedJobs.push(stoppedJob);
    return stoppedJob;
  });

  saveState(workspaceRoot, { ...state, jobs });

  for (const job of stoppedJobs) {
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (!fs.existsSync(jobFile)) {
      continue;
    }
    try {
      writeJobFile(workspaceRoot, job.id, {
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
}

// Closing the desktop window never delivers SessionEnd, so the teardown that
// hangs off it simply does not run for the way most sessions actually end:
// records stay frozen at "running" behind a pid that is long gone, and the
// broker's pid and log files outlive the process they describe. Nothing else
// sweeps them either — the workspace has to be used again for the lazy paths
// (listJobs, loadReusableBrokerSession) to notice. So the next session opening
// on this workspace picks up what the previous one could not put down.
//
// Only the dead are reaped. A live pid may belong to a second window working
// in the same workspace, or to a run deliberately left finishing, and killing
// either would destroy work this session never started.
function reapAbandonedRuntime(cwd) {
  // listJobs reconciles queued/running records whose pid is gone, flipping
  // them to failed and rewriting their per-job files. Results and logs stay.
  listJobs(cwd);

  const brokerSession = loadBrokerSession(cwd);
  if (!brokerSession || isProcessAlive(brokerSession.pid)) {
    return;
  }

  // The pid is dead, so there is nothing to kill — and nothing that may be
  // killed: the OS could have recycled that pid into an unrelated process by
  // now. Drop the files only, exactly as loadReusableBrokerSession does when
  // it finds the same situation.
  teardownBrokerSession({
    endpoint: brokerSession.endpoint ?? null,
    pidFile: brokerSession.pidFile ?? null,
    logFile: brokerSession.logFile ?? null,
    sessionDir: brokerSession.sessionDir ?? null,
    pid: null,
    killProcess: null
  });
  clearBrokerSession(cwd);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);

  try {
    reapAbandonedRuntime(input.cwd || process.cwd());
  } catch {
    // Housekeeping must never keep a session from starting.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
