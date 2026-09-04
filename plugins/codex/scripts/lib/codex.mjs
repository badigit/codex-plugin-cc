/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   resetIdleDeadline: (() => void) | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { validateExplicitReasoningSelection, validateReasoningSelection } from "./model-catalog.mjs";
import { isTaskThreadName, taskThreadSearchTerm } from "./task-thread.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
// [dim] Review threads are never looked up by name (unlike task threads), so
// this rename is cosmetic: it just stops every row in the Codex app's session
// list from starting with the plumbing word "Companion".
const REVIEW_THREAD_PREFIX = "Codex Review";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

// Bound turn/interrupt itself (#47 finding 2). It is awaited inside
// captureTurn's catch, in a window that by construction has only the
// wall-clock ceiling's cleanup margin left before the host's own SIGKILL
// (see DEFAULT_HARD_WALL_CLOCK_CEILING_MS below). Without a deadline here, a
// broker that accepts the connection and then goes silent blocks the
// companion until the host kills it, and the original turn keeps running
// with nobody able to reach it.
const TURN_INTERRUPT_TIMEOUT_MS = 5000;

// Hard upper bound on Codex agent inactivity within a single turn. Without
// this, the completion await at the end of captureTurn is unbounded: it is
// resolved ONLY by completeTurn() and is never rejected on a stalled/dead
// process (rejectCompletion was dead code). The foreground budget is set
// below the external Bash ceiling by the companion so timeouts surface as
// structured errors instead of a SIGKILL.
// Originally ported as a fixed whole-turn budget from @russjhammond's
// openai/codex-plugin-cc#376; redesigned as an idle (inactivity) budget —
// see resolveTurnTimeoutMs below for why.
const DEFAULT_TURN_TIMEOUT_MS = 600000;

// Coarse wall-clock failsafe, independent of the idle budget. The idle timer
// resets on every turn/started, item/started, item/completed, and in-item
// progress/delta notification, so a turn that keeps producing events — even
// slowly, e.g. gpt-5.6-sol at effort=xhigh on a large diff routinely runs
// well past 10 minutes while still making progress — is never killed by the
// idle budget alone.
//
// The ceiling therefore serves two different purposes depending on the host:
//   - background: catch the case the idle budget can't — a turn that resets
//     its own idle timer forever without ever completing (runaway tool-call
//     loop). Generous by design; this default applies.
//   - foreground: also stay below the host's own kill. Claude Code's Bash
//     tool SIGKILLs node at ~120s, and a foreground turn that outlives that
//     is killed before captureTurn's catch can send turn/interrupt — leaving
//     a live, possibly write-capable turn running on the broker with no way
//     to reach it. The companion passes its 110s foreground budget as the
//     ceiling so the interrupt always wins the race. See #43.
const DEFAULT_HARD_WALL_CLOCK_CEILING_MS = 45 * 60 * 1000;

// Resolve the per-turn idle budget at CALL time, not import time. The
// companion sets CODEX_TURN_TIMEOUT_MS (e.g. the foreground budget, below
// the Bash ceiling) AFTER this module is imported; reading it at import
// froze the value at the default and made --turn-timeout-ms / the
// foreground budget inert.
//
// This budget measures INACTIVITY, not total turn duration: it resets on
// every turn/started, item/started, and item/completed notification (see
// applyTurnNotification -> resetIdleDeadline). A turn that keeps producing
// events can run indefinitely; only a gap this long with no events at all
// trips it. A separate wall-clock ceiling (resolveHardCeilingMs) backstops a
// turn that never stops resetting its own idle timer.
function resolveTurnTimeoutMs(options = {}) {
  const fromOptions = Number(options.turnTimeoutMs);
  if (Number.isFinite(fromOptions) && fromOptions > 0) {
    return fromOptions;
  }
  const fromEnv = Number(process.env.CODEX_TURN_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

// Resolve the hard wall-clock ceiling at call time, mirroring
// resolveTurnTimeoutMs. Precedence: explicit option (the companion passes
// 110s for foreground, 45min for background) > CODEX_TURN_HARD_CEILING_MS
// env override (tests, non-Claude hosts with a different external kill) >
// the generous default. See DEFAULT_HARD_WALL_CLOCK_CEILING_MS.
function resolveHardCeilingMs(options = {}) {
  const fromOptions = Number(options.hardCeilingMs);
  if (Number.isFinite(fromOptions) && fromOptions > 0) {
    return fromOptions;
  }
  const fromEnv = Number(process.env.CODEX_TURN_HARD_CEILING_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_HARD_WALL_CLOCK_CEILING_MS;
}

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

// [dim] `null` is deliberate, not an omission: with no sandbox in the params the
// app-server resolves it from the host's own ~/.codex/config.toml. The host is
// the authority on how much access its agents get — a plugin that quietly pins
// read-only over a machine configured for full access is overriding a decision
// that was not its to make, and does it invisibly.
//
// The consequence is exactly what the host asked for: on a machine running
// sandbox_mode = "danger-full-access" with approval_policy = "never", an
// unflagged delegated task inherits full filesystem access without approvals.
// Explicit callers are unaffected — --write and --read-only still pin their own
// sandbox, and assertExplicitSandboxHonored still fails closed when an explicit
// read-only pin is not honored on resume.
const DEFAULT_SANDBOX = null;

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? DEFAULT_SANDBOX,
    config: options.effort ? { model_reasoning_effort: options.effort } : null,
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? DEFAULT_SANDBOX
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

// Map a requested sandbox shorthand ("read-only"/"workspace-write") to the
// app-server's sandbox-type vocabulary ("readOnly"/"workspaceWrite").
function requestedSandboxType(requested) {
  if (requested === "read-only") {
    return "readOnly";
  }
  if (requested === "workspace-write") {
    return "workspaceWrite";
  }
  return null;
}

// Fail closed when an explicit read-only pin was requested but the app-server
// resolved a write-capable sandbox. Codex 0.144.x keeps a loaded thread's
// sandbox and ignores thread/resume overrides, so without this check
// --read-only --resume-last could silently run with write access. (The write
// pin is not enforced here: a write request on a read-only resolved sandbox is
// a downgrade, not a safety leak.)
function assertExplicitSandboxHonored(requested, resolved) {
  if (requestedSandboxType(requested) !== "readOnly") {
    return;
  }
  const resolvedType = resolved?.type ?? null;
  if (resolvedType === "readOnly") {
    return;
  }
  throw new Error(
    `Requested a read-only sandbox, but the app-server resolved ${resolvedType ?? "an unknown sandbox"} — refusing to run with a sandbox that does not match the explicit read-only pin. Start a fresh thread or drop --read-only.`
  );
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildReviewThreadName(targetLabel) {
  const excerpt = shorten(targetLabel, 56);
  return excerpt ? `${REVIEW_THREAD_PREFIX}: ${excerpt}` : REVIEW_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    case "reasoning":
      return { message: "Thinking.", phase: null };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    resetIdleDeadline: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      state.resetIdleDeadline?.();
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      state.resetIdleDeadline?.();
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      state.resetIdleDeadline?.();
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    // In-item progress/delta notifications: a single item (a long command
    // execution, an MCP tool call, streamed model/reasoning output) can run
    // well past the idle budget while continuously producing these without
    // ever emitting another item/started or item/completed in between. Treat
    // them as activity too, or a genuinely progressing item gets interrupted
    // mid-flight — the exact failure mode this idle timeout exists to avoid.
    // Every method below carries threadId + turnId, so belongsToTurn can route
    // it to this turn. Two sibling methods deliberately do NOT appear here:
    // command/exec/outputDelta and process/outputDelta are connection-scoped
    // (their params carry only processId / processHandle, no threadId), so
    // belongsToTurn can never match them and a case for them is dead code.
    // item/fileChange/outputDelta is kept although upstream deprecated it
    // ("the server no longer emits this notification") — an older app-server
    // may still send it, and treating it as activity costs nothing.
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      state.resetIdleDeadline?.();
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  });

  try {
    // Arm the idle deadline BEFORE startRequest so a stalled turn/start
    // (app-server alive but not responding) is also bounded. Finding #27-2.
    // Unlike a fixed whole-turn budget, this deadline is RESET on every
    // turn/started, item/started, and item/completed notification (wired via
    // state.resetIdleDeadline, consumed in applyTurnNotification) — it only
    // fires after a gap of silence at least this long, not after a fixed
    // amount of total turn time.
    const idleTimeoutMs = resolveTurnTimeoutMs(options);
    let idleTimer = null;
    let rejectIdleDeadline = null;
    const armIdleDeadline = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        rejectIdleDeadline?.(new Error(`codex turn exceeded the ${idleTimeoutMs}ms turn budget.`));
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const idleDeadline = new Promise((_resolve, reject) => {
      rejectIdleDeadline = reject;
      armIdleDeadline();
    });
    state.resetIdleDeadline = armIdleDeadline;

    // Coarse wall-clock failsafe: never reset, catches a turn that keeps
    // resetting its own idle timer forever without ever completing. In the
    // foreground it also keeps the turn inside the host's own kill window so
    // the interrupt in the catch below can still run (#43).
    const hardCeilingMs = resolveHardCeilingMs(options);
    let wallClockTimer = null;
    const wallClockCeiling = new Promise((_resolve, reject) => {
      wallClockTimer = setTimeout(() => {
        reject(new Error(`codex turn exceeded the ${hardCeilingMs}ms hard wall-clock ceiling.`));
      }, hardCeilingMs);
      wallClockTimer.unref?.();
    });

    // Wire exitPromise to rejectCompletion so an app-server death at any point
    // (during startRequest OR during completion) rejects immediately.
    client.exitPromise.then(() => {
      if (state.completed) {
        return;
      }
      state.rejectCompletion(
        client.exitError ?? new Error("codex app-server exited before the turn completed.")
      );
    });

    let result;
    try {
      // Race the entire lifecycle (startRequest + completion) against the
      // idle deadline and the wall-clock failsafe.
      result = await Promise.race([
        (async () => {
          const response = await startRequest();
          options.onResponse?.(response, state);
          state.turnId = response.turn?.id ?? null;
          if (state.turnId) {
            state.threadTurnIds.set(state.threadId, state.turnId);
          }
          for (const message of state.bufferedNotifications) {
            if (belongsToTurn(state, message)) {
              applyTurnNotification(state, message);
            } else {
              if (previousHandler) {
                previousHandler(message);
              }
            }
          }
          state.bufferedNotifications.length = 0;

          if (response.turn?.status && response.turn.status !== "inProgress") {
            completeTurn(state, response.turn);
          }

          return await state.completion;
        })(),
        idleDeadline,
        wallClockCeiling
      ]);
    } catch (error) {
      // Finding #27-1: on deadline, interrupt the in-flight turn so the broker
      // stops executing a write-capable task after we've reported it failed.
      // Best-effort: if interrupt fails (broker gone, network down), the error
      // from the deadline still propagates — we just don't block on it.
      if (state.threadId && state.turnId && options.cwd) {
        await interruptAppServerTurn(options.cwd, {
          threadId: state.threadId,
          turnId: state.turnId,
          timeoutMs: TURN_INTERRUPT_TIMEOUT_MS
        }).catch(() => {});
      }
      throw error;
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (wallClockTimer) {
        clearTimeout(wallClockTimer);
      }
    }
    return result;
  } finally {
    state.resetIdleDeadline = null;
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

export async function withAppServer(cwd, fn, clientOptions = {}) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, clientOptions);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    // Fall back to a direct (non-broker) app-server when the broker transport
    // is unusable. Two distinct shapes:
    //  - broker/busy (-32001) arrives AFTER a successful handshake, while
    //    `client` is assigned — read the transport off the client.
    //  - a handshake failure (timeout / ENOENT / ECONNREFUSED) rejects inside
    //    connect() before `client` is assigned — tagged brokerFatal in
    //    CodexAppServerClient.connect.
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      error?.brokerFatal === true;

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { ...clientOptions, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

// [dim] Escape hatch for anyone who WANTS delegated runs in the Codex session
// list — same env-var shape as CODEX_TASK_THREAD_PREFIX.
const KEEP_THREADS_VISIBLE_ENV = "CODEX_COMPANION_KEEP_THREADS_VISIBLE";

export function keepThreadsVisible(env = process.env) {
  const raw = String(env[KEEP_THREADS_VISIBLE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// A persisted delegated thread is not a session the human started, but Codex has
// no way to say so: the source kind is derived from the transport (every one of
// ours lands as "vscode"), thread/start silently ignores a client-supplied
// `sourceKind`, and `threadSource` is analytics only — no list filter reads it.
// Archiving is the one mechanism that actually removes a thread from the default
// list while keeping it on disk and resumable, so that is what we use.
//
// Best-effort by design: an older CLI without the method, or a thread the server
// refuses to archive, must not fail a run whose work is already done.
async function archiveThreadQuietly(client, threadId, onProgress) {
  try {
    await client.request("thread/archive", { threadId });
    return true;
  } catch (error) {
    emitProgress(onProgress, `Could not archive thread ${threadId}: ${error?.message ?? error}`, "running");
    return false;
  }
}

// Resuming an archived thread is refused outright ("session … is archived"), so
// every resume has to lift the archive first. Failure is not fatal here either:
// a thread that was never archived answers with an error, and the resume that
// follows is the real check.
async function unarchiveThreadQuietly(client, threadId) {
  try {
    await client.request("thread/unarchive", { threadId });
  } catch {
    // Not archived, or an older CLI without the method — let the resume decide.
  }
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

// A control-plane RPC (send-interrupt-and-acknowledge), not agent work — it
// must not hang the way a turn can. Callers that gate a state transition on
// the result (e.g. /codex:cancel finalizing an orphaned job) need a bounded
// wait so a stuck broker/transport fails fast instead of leaving the caller
// stalled indefinitely on this await. CODEX_INTERRUPT_TIMEOUT_MS lets tests
// shrink this the same way CODEX_TURN_TIMEOUT_MS overrides the turn budget.
const DEFAULT_INTERRUPT_TIMEOUT_MS = 15000;

function resolveInterruptTimeoutMs(timeoutMs) {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  const fromEnv = Number(process.env.CODEX_INTERRUPT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_INTERRUPT_TIMEOUT_MS;
}

/**
 * @param {string} cwd
 * @param {{ threadId?: string, turnId?: string, timeoutMs?: number }} [options]
 */
export async function interruptAppServerTurn(cwd, options = {}) {
  const { threadId, turnId, timeoutMs } = options;
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  const resolvedTimeoutMs = resolveInterruptTimeoutMs(timeoutMs);

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      reuseExistingBroker: true,
      allowBusyStaleBroker: true
    });
    await client.request("turn/interrupt", { threadId, turnId }, {
      timeoutMs: resolvedTimeoutMs,
      // A wedged peer that accepted the connection but goes silent must not
      // linger past the timeout: force-close so callers aren't blocked
      // beyond resolvedTimeoutMs regardless of transport.
      onTimeout: () => client?.close().catch(() => {})
    });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    await validateExplicitReasoningSelection(client, cwd, options);
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const response = await startThread(client, cwd, {
      model: options.model,
      effort: options.effort,
      sandbox: "read-only",
      ephemeral: false,
      threadName: options.threadName ?? buildReviewThreadName(options.target?.label)
    });
    const sourceThreadId = response.thread.id;
    const resolved = {
      model: response.model,
      modelProvider: response.modelProvider,
      reasoningEffort: response.reasoningEffort,
      sandbox: response.sandbox
    };
    await validateReasoningSelection(client, {
      model: options.model ?? response.model,
      effort: options.effort ?? response.reasoningEffort,
      modelProvider: response.modelProvider
    });
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId,
      resolved
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        cwd,
        turnTimeoutMs: options.turnTimeoutMs,
        hardCeilingMs: options.hardCeilingMs,
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      resolved,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, { model: options.model, effort: options.effort });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let response;
    let threadSelection;

    if (!options.resumeThreadId) {
      await validateExplicitReasoningSelection(client, cwd, options, {
        includeInherited: options.persistThread === true
      });
    }

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      await unarchiveThreadQuietly(client, options.resumeThreadId);
      response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadSelection = response;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadSelection = response;
    }

    const threadId = response.thread.id;
    let resolved = {
      model: response.model,
      modelProvider: response.modelProvider,
      reasoningEffort: response.reasoningEffort,
      sandbox: response.sandbox
    };
    // Fail closed when an explicit sandbox pin is not honored. Codex app-server
    // (0.144.x) keeps a loaded thread's sandbox and ignores thread/resume
    // overrides, so --read-only --resume-last on a write-capable thread would
    // otherwise run with write access — violating the --read-only contract.
    assertExplicitSandboxHonored(options.sandbox, resolved.sandbox);
    await validateReasoningSelection(client, {
      model: options.model ?? threadSelection.model,
      effort: options.effort ?? threadSelection.reasoningEffort,
      modelProvider: threadSelection.modelProvider
    });


    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId,
      resolved
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      {
        cwd,
        turnTimeoutMs: options.turnTimeoutMs,
        hardCeilingMs: options.hardCeilingMs,
        onProgress: options.onProgress,
        onResponse() {
          if (!options.effort) {
            return;
          }
          resolved = { ...resolved, reasoningEffort: options.effort };
          options.onProgress?.({ message: "", resolved });
        }
      }
    );

    // Persisted threads only: an ephemeral one was never on disk and is not in
    // any list to begin with. Archive AFTER the turn, never before — the server
    // refuses to resume an archived thread, so archiving early would break a
    // run mid-flight.
    const persisted = options.persistThread === true || Boolean(options.resumeThreadId);
    if (persisted && !keepThreadsVisible()) {
      await archiveThreadQuietly(client, threadId, options.onProgress);
    }

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      resolved,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  }, { model: options.model, effort: options.effort });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  // Two server-side filters were dropped here because both match NOTHING,
  // silently (probed against codex 0.146.0):
  //   - sourceKinds: ["appServer"] — our threads are recorded as "vscode". The
  //     kind comes from the transport, not from clientInfo, and no appServer
  //     thread exists on a machine that has run hundreds of delegated tasks.
  //   - cwd — `searchTerm` alone finds a thread whose own `cwd` is exactly the
  //     value passed; adding `cwd` to the same call returns zero. The stored
  //     column the filter reads is not the one thread.cwd is repaired from.
  // Both are applied in JS below instead, where they can be verified.
  //
  // Archived threads are listed too: once a completed run is archived, the
  // default (non-archived) listing can no longer see any of our own work.
  return withAppServer(cwd, async (client) => {
    const listParams = { limit: 40, sortKey: "updated_at", searchTerm: taskThreadSearchTerm() };
    const [visible, archived] = await Promise.all([
      client.request("thread/list", listParams),
      client.request("thread/list", { ...listParams, archived: true }).catch(() => ({ data: [] }))
    ]);

    const matchesCwd = (thread) => !thread.cwd || pathsEqual(thread.cwd, cwd);

    return (
      [...visible.data, ...archived.data]
        .filter((thread) => isTaskThreadName(thread.name) && matchesCwd(thread))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0] ?? null
    );
  });
}

// Windows: the same directory reaches us as both "C:\\x\\y" and "C:/x/y", and
// case differs between what the shell hands over and what Codex stored.
function pathsEqual(left, right) {
  const normalize = (value) => String(value ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
