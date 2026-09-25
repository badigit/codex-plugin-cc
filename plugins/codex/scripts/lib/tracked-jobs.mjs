import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      resolved: value.resolved && typeof value.resolved === "object" && !Array.isArray(value.resolved) ? value.resolved : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      brokerEndpoint: Object.hasOwn(value, "brokerEndpoint") ? value.brokerEndpoint : undefined
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    resolved: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null,
    brokerEndpoint: undefined
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastResolved = null;
  let lastBrokerEndpoint;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.resolved && normalized.resolved !== lastResolved) {
      lastResolved = normalized.resolved;
      patch.resolved = normalized.resolved;
      changed = true;
    }

    if (normalized.brokerEndpoint !== undefined && normalized.brokerEndpoint !== lastBrokerEndpoint) {
      lastBrokerEndpoint = normalized.brokerEndpoint;
      patch.brokerEndpoint = normalized.brokerEndpoint;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function stopTrackedJobIfCancelled(job, logFile) {
  const storedJob = readStoredJobOrNull(job.workspaceRoot, job.id);
  if (storedJob?.status !== "cancelled") {
    return null;
  }

  upsertJob(job.workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: storedJob.pid ?? null,
    errorMessage: storedJob.errorMessage ?? "Cancelled by user.",
    completedAt: storedJob.completedAt ?? nowIso()
  });
  appendLogLine(logFile, "Stopped after cancellation.");
  return {
    exitStatus: 0,
    threadId: storedJob.threadId ?? null,
    turnId: storedJob.turnId ?? null,
    payload: { status: "cancelled" },
    rendered: "",
    summary: storedJob.summary ?? "Cancelled by user."
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const cancelledBeforeStart = stopTrackedJobIfCancelled(job, logFile);
  if (cancelledBeforeStart) {
    return cancelledBeforeStart;
  }

  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const cancelledDuringRun = stopTrackedJobIfCancelled(job, logFile);
    if (cancelledDuringRun) {
      return cancelledDuringRun;
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // A run that returns (rather than throws) with a non-zero exitStatus —
    // e.g. a turn the app-server itself marks failed — carries its own
    // errorMessage on the execution result. Only set the key when there
    // actually is one, so a successful completion's job record keeps its
    // existing shape (no `errorMessage: null` key added).
    const executionErrorMessage = execution.errorMessage ? { errorMessage: execution.errorMessage } : {};
    // Terminal-status --output-schema cleanup (stripping request.outputSchema,
    // leaving outputSchemaUsed) happens inside writeJobFile itself — see
    // sanitizeTerminalJobRecord in state.mjs — not here, so every path that
    // writes a terminal job record gets it, not just this one.
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      resolved: execution.resolved ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      ephemeral: execution.payload?.ephemeral === true,
      rendered: execution.rendered,
      ...executionErrorMessage
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      resolved: execution.resolved ?? null,
      summary: execution.summary,
      ephemeral: execution.payload?.ephemeral === true,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      ...executionErrorMessage,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const cancelledDuringRun = stopTrackedJobIfCancelled(job, logFile);
    if (cancelledDuringRun) {
      return cancelledDuringRun;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}

function markWorkerJobDead(workspaceRoot, jobId, logFile, errorMessage) {
  const stored = readStoredJobOrNull(workspaceRoot, jobId);
  if (stored && stored.status !== "running" && stored.status !== "queued") {
    // Already terminal (e.g. /codex:cancel wrote "cancelled" and delivered the
    // SIGTERM this guard is reacting to) — don't race that state back to failed.
    return;
  }
  const base = stored ?? { id: jobId, status: "running", logFile };
  const completedAt = nowIso();
  writeJobFile(workspaceRoot, jobId, {
    ...base,
    status: "failed",
    phase: "failed",
    errorMessage,
    pid: null,
    completedAt
  });
  upsertJob(workspaceRoot, {
    id: jobId,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  });
  appendLogLine(logFile ?? base.logFile ?? null, `Marked failed: ${errorMessage}`);
}

// Guards only against in-process crashes (uncaughtException / unhandledRejection)
// where a precise error is available and no other command is writing the job.
// Signal-based deaths (SIGTERM/SIGINT/SIGHUP/SIGKILL) are intentionally NOT
// caught here: SIGKILL is uncatchable, so a reader-side liveness check (see
// state.mjs's reconcileRunningJobs, which now also covers "queued") must cover
// process death regardless, and /codex:cancel delivers SIGTERM as its teardown
// signal after already writing the job "cancelled" — catching it here would
// race that terminal state back to "failed". markWorkerJobDead never rewrites
// a job that already reached a terminal status, so a same-tick cancel wins.
export function registerWorkerCrashGuard(workspaceRoot, jobId, logFile = null) {
  const mark = (label) => (reason) => {
    try {
      const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason ?? "");
      appendLogLine(logFile, `Worker ${label}: ${detail}`);
      markWorkerJobDead(workspaceRoot, jobId, logFile, `worker ${label}: ${detail.split("\n")[0]}`);
    } catch {
      // Never let the guard itself throw during teardown.
    }
    process.exit(1);
  };
  process.on("uncaughtException", mark("uncaughtException"));
  process.on("unhandledRejection", mark("unhandledRejection"));
}
