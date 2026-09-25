#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
  importExternalAgentSession,
  interruptAppServerTurn,
  runAppServerReview,
  runAppServerTurn
} from "./lib/codex.mjs";
import { parseStructuredOutput, readOutputSchema } from "./lib/structured-output.mjs";
import { validateScratchSandboxThreadStart } from "./lib/scratch-sandbox.mjs";
import { buildPersistentTaskThreadName, DEFAULT_CONTINUE_PROMPT, normalizeTaskLabel, TASK_THREAD_LABELS } from "./lib/task-thread.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  acquireScratchSandboxLock,
  generateJobId,
  getConfig,
  isDeadWorkerFailure,
  listJobs,
  resetScratchSandboxDir,
  resolveStateDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  CANCELLATION_INTERRUPT_REQUIRED_MESSAGE,
  isOrphanedTurn,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  settleCancellationAfterTermination,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  registerWorkerCrashGuard,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
// The wait suggested to the caller right after a background launch. The status
// default (4 minutes) is tuned for a human checking in; a delegated rescue run
// routinely thinks for longer, and a wait that expires before the run finishes
// drops the caller straight back into "Codex said nothing".
const BACKGROUND_COLLECT_TIMEOUT_MS = 1800000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const TASK_WORKER_RECORD_WAIT_TIMEOUT_MS = 1000;
// `wait` is called immediately after `task --background` returns, often in
// the very same tool-call sequence. The detached worker (spawnDetachedTaskWorker)
// takes its own moment to start and write the job's first index entry, so the
// job id `task --background` just printed can still be unknown to `wait`'s
// very first lookup even though the launch itself succeeded. Retry only the
// specific "No job found" miss, bounded, rather than either failing outright
// (case seen live 23.09.2026: `wait` right after `task --background` returned
// "No job found" once before the index caught up) or looping forever on a
// job id that was simply wrong.
const WAIT_JOB_INDEX_RETRY_MS = 15000;
const NO_JOB_FOUND_MESSAGE_PATTERN = /^No job found for /;
// Overridable so tests exercising "the job id genuinely does not exist" (the
// SAME error message, but no worker ever coming) do not have to burn the full
// 15s default to see it fail.
// `Number(x) || fallback` treats an explicit 0 as "unset": `--timeout-ms 0`
// then waited the full default instead of giving up at once. Only a missing
// or non-numeric value falls back; negatives clamp to 0.
function resolveExplicitTimeoutMs(value, fallbackMs) {
  if (value == null || value === "") {
    return fallbackMs;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallbackMs;
}

function resolveWaitJobIndexRetryMs(env = process.env) {
  const fromEnv = Number(env.CODEX_COMPANION_WAIT_INDEX_RETRY_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : WAIT_JOB_INDEX_RETRY_MS;
}
// Foreground runs are invoked by Claude Code's Bash tool, which SIGKILLs node
// at its own timeout (default 120000ms) and returns nothing. Set the runtime
// turn budget just below that so a stalled foreground turn fails fast with a
// structured error instead of being killed with an empty result.
// Ported from @russjhammond's openai/codex-plugin-cc#376.
const FOREGROUND_TURN_TIMEOUT_MS = 110000;
// Background runs have no external Bash ceiling — give them the full default budget.
const DEFAULT_TURN_TIMEOUT_MS = 600000;
// Hard wall-clock ceiling: a second, non-resettable failsafe under the idle
// budget above. The idle deadline is reset by every notification, so a turn
// that keeps producing events can run indefinitely — correct for background
// work, but fatal in the foreground, where Claude Code's Bash tool SIGKILLs
// node at ~120s. A foreground turn that sails past that is killed before
// captureTurn's catch can send turn/interrupt, orphaning a live, possibly
// write-capable turn on the broker. So the foreground ceiling stays below the
// host kill (matching FOREGROUND_TURN_TIMEOUT_MS), while background keeps a
// generous ceiling that only catches a runaway turn resetting its own timer
// forever. Closes #43.
const DEFAULT_TURN_HARD_CEILING_MS = 45 * 60 * 1000;
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const VALID_REASONING_EFFORTS = new Set(REASONING_EFFORTS);
// Встроенные сокращения. Список моделей у аккаунта меняется быстрее, чем
// выходят версии плагина — 08.09.2026 дефолтом стала gpt-6-astra, которой
// установленный CLI ещё не знал, — поэтому он НЕ должен быть единственным
// способом назвать модель. Их три:
//   1. полное имя работает всегда: --model gpt-6-astra уходит на сервер как есть;
//   2. свои сокращения — CODEX_MODEL_ALIASES="astra=gpt-6-astra,mini=gpt-6-mini";
//   3. короткое имя, не совпавшее ни с чем, доразрешается по каталогу
//      model/list (см. resolveModelFromCatalog) — новая модель подхватывается
//      сама, без правки конфига.
const BUILTIN_MODEL_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["sol", "gpt-5.6-sol"],
  ["terra", "gpt-5.6-terra"],
  ["luna", "gpt-5.6-luna"]
]);
const MODEL_ALIASES_ENV = "CODEX_MODEL_ALIASES";

// Формат намеренно примитивный: `имя=модель`, разделители — запятая, точка с
// запятой или перенос строки. Записи с мусором пропускаем молча: сорвать
// делегированный прогон из-за лишней запятой в переменной окружения хуже, чем
// проигнорировать её.
function modelAliases(env = process.env) {
  const aliases = new Map(BUILTIN_MODEL_ALIASES);
  for (const entry of String(env[MODEL_ALIASES_ENV] ?? "").split(/[,;\n]/)) {
    const [rawAlias, ...rest] = entry.split("=");
    const alias = String(rawAlias ?? "").trim().toLowerCase();
    const target = rest.join("=").trim();
    if (alias && target) {
      aliases.set(alias, target);
    }
  }
  return aliases;
}
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// Prepended to the prompt for `task --scratch-sandbox` (see executeTaskRun):
// the sandbox's cwd is the scratch directory, not the repository, so Codex
// needs to be told explicitly where the repository actually is and that it
// has to `cd` there to inspect it or run commands against it.
function buildScratchSandboxPreamble(repoAbsPath) {
  return (
    `The current directory is a scratch sandbox, not the repository. ` +
    `The repository is available read-only at ${repoAbsPath} — run \`cd ${repoAbsPath}\` first to inspect it or run commands (including tests) against it. ` +
    `Write any temporary files, test artifacts, or command output only in the current directory (the scratch sandbox). ` +
    `Do not attempt to modify anything inside the repository; those writes will be denied.`
  );
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--read-only] [--scratch-sandbox] [--cwd <dir>] [--prompt-file <path>] [--output-schema <path>] [--resume-last|--resume|--fresh] [--label <task|review|rescue>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]",
      "    --output-schema forwards a JSON Schema to Codex's structured output; `result --json`/`task --json` then carry the parsed answer as `structured`. The companion only JSON.parses the answer — schema conformance is enforced by Codex's own strict structured-output mode, not validated here.",
      "    --scratch-sandbox runs Codex with a workspace-write sandbox rooted at a per-repository scratch directory instead of the repository itself, with TEMP/TMP pointed there too — for running the repo's own tests, which often need a writable temp dir even under a read-only review. Self-contained: the repository stays read-only (reachable via `cd <repo>` inside the sandbox) on its own, so it takes neither --write nor --read-only, and only supports a fresh task (not --resume/--resume-last).",
      "  node scripts/codex-companion.mjs prompt-path [--cwd <dir>] [--label <name>] [--json]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs wait <job-id> [--timeout-ms N] [--cwd <dir>] [--json]",
      "    Blocks until the job leaves queued/running, then prints its result (same as `status --wait` + `result`, in one call). Run this as a BACKGROUND tool call so the host delivers one notification with the answer. Exit codes: 0 completed, 1 failed/cancelled, 2 still running (--timeout-ms ran out; retry the same command).",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return modelAliases().get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${REASONING_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}

function announceRun(model, effort) {
  const m = model ?? "default";
  const e = effort ?? "default";
  process.stderr.write(`Codex: model=${m} effort=${e}\n`);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function resolveTaskCwd(options = {}) {
  const cwd = resolveCommandCwd(options);
  if (!options.cwd) {
    return cwd;
  }

  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Task workspace directory does not exist: ${cwd}`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Task workspace path is not a directory: ${cwd}`);
  }
  return cwd;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStoredJob(workspaceRoot, jobId) {
  const deadline = Date.now() + TASK_WORKER_RECORD_WAIT_TIMEOUT_MS;
  let storedJob = readStoredJob(workspaceRoot, jobId);
  while (!storedJob && Date.now() < deadline) {
    await sleep(25);
    storedJob = readStoredJob(workspaceRoot, jobId);
  }
  return storedJob;
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target) {
  // Parity with /codex:adversarial-review: positional focus text no longer
  // aborts the native review. The native reviewer (review/start) does not
  // consume focus text, so leftover positional words are silently ignored
  // rather than rejecting the invocation. This keeps `/codex:review --model sol`
  // usable when a host forwards residual positional text alongside flags,
  // and removes an interface-parity gap with /codex:adversarial-review (#522).
  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs, options = {}) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running" &&
        (!options.excludeDeadWorkerFailures || !isDeadWorkerFailure(job))
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = resolveExplicitTimeoutMs(options.timeoutMs, DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

// See WAIT_JOB_INDEX_RETRY_MS above for why this retries on that one specific
// error message rather than any lookup failure. A reference that genuinely
// does not resolve to a job (typo, wrong workspace) keeps throwing past the
// retry budget and surfaces the same "No job found" error `status`/`result`
// already give.
async function waitForJobToAppear(cwd, reference, options = {}) {
  // An explicit 0 means "no budget left" (caller's deadline already spent) and
  // must not fall back to the default 15s: only a missing value does.
  const requestedBudgetMs = Number(options.retryBudgetMs);
  const retryBudgetMs = Math.max(
    0,
    options.retryBudgetMs == null || !Number.isFinite(requestedBudgetMs) ? resolveWaitJobIndexRetryMs() : requestedBudgetMs
  );
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + retryBudgetMs;

  for (;;) {
    try {
      return buildSingleJobSnapshot(cwd, reference);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!NO_JOB_FOUND_MESSAGE_PATTERN.test(message) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      effort: request.effort,
      turnTimeoutMs: request.turnTimeoutMs,
      hardCeilingMs: request.hardCeilingMs,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      ephemeral: true,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      resolved: result.resolved,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const focusText = request.focusText?.trim() ?? "";
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    persistThread: false,
    turnTimeoutMs: request.turnTimeoutMs,
    hardCeilingMs: request.hardCeilingMs,
    threadName: `Codex Review: ${context.target.label}`.slice(0, 80)
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    ephemeral: true,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


// A failed turn (exitStatus != 0) normally carries a reason: the app-server's
// own "error" notification (folded into failureMessage above) or stderr from
// a dead process. But a turn can also come back resolved (not thrown) with a
// non-"completed" status and NEITHER of those — e.g. an interrupted turn, or
// a future app-server status this runtime does not special-case. Without a
// fallback here, errorMessage stayed null and a failed job's `result` had
// nothing to show for why it failed. Prefer the app-server's own turn.status
// string ("failed", "interrupted", ...) when there is one; fall back to the
// raw numeric exit status otherwise.
function describeUnexplainedTaskFailure(result) {
  const status = result.turn?.status ?? result.status;
  return `Codex turn ended with status ${status} and no error message.`;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // --scratch-sandbox: run Codex against a persistent per-repository scratch
  // directory instead of the repository itself. cwd (and therefore the sole
  // workspace-write writable root — see buildThreadConfigOverrides in
  // lib/codex.mjs) becomes the scratch directory, TEMP/TMP are pointed at it
  // so tempfile-based tests get a writable temp dir under the sandbox, and
  // the prompt is told where the real repository is and that it is
  // read-only. The repository itself is never made a writable root here.
  //
  // A fresh thread only: `--scratch-sandbox` is rejected together with
  // `--resume`/`--resume-last` before this function is ever reached (see
  // handleTask) — thread/resume keeps a loaded thread's own sandbox and does
  // not honor most of what this mode overrides, so the guarantee the flag
  // makes cannot be kept on a resumed thread. codex.mjs's runAppServerTurn
  // also refuses that combination itself as a second guard.
  let runCwd = workspaceRoot;
  let envOverrides;
  let writableRoots;
  let promptForRun = request.prompt;
  let assertThreadStartHonored;
  let sandboxEffective = null;
  let releaseScratchLock = null;
  let result;

  if (request.scratchSandbox) {
    // The scratch directory is a FIXED path per repository (see
    // resolveScratchSandboxDir), so two `--scratch-sandbox` jobs on the same
    // repository running at once would race on clearing/using it — held for
    // the whole "clear scratch → turn finished" interval, released in the
    // `finally` below (code-review finding IMPORTANT #4).
    releaseScratchLock = await acquireScratchSandboxLock(workspaceRoot, request.jobId, {
      timeoutMs: request.scratchLockTimeoutMs,
      pollIntervalMs: request.scratchLockPollIntervalMs
    });
  }

  try {
    if (request.scratchSandbox) {
      const scratchDir = resetScratchSandboxDir(workspaceRoot);
      runCwd = scratchDir;
      envOverrides = { TEMP: scratchDir, TMP: scratchDir };
      writableRoots = [scratchDir];
      assertThreadStartHonored = (response) => {
        sandboxEffective = validateScratchSandboxThreadStart(response, { scratchDir, repoRoot: workspaceRoot });
      };
      if (request.prompt) {
        promptForRun = `${buildScratchSandboxPreamble(workspaceRoot)}\n\n${request.prompt}`;
      }
    }

    result = await runAppServerTurn(runCwd, {
      resumeThreadId,
      prompt: promptForRun,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model: request.model,
      effort: request.effort,
      sandbox: request.scratchSandbox ? "workspace-write" : request.write ? "workspace-write" : request.readOnly ? "read-only" : null,
      envOverrides,
      writableRoots,
      assertThreadStartHonored,
      outputSchema: request.outputSchema ?? null,
      onProgress: request.onProgress,
      // Existing threads remain resumable; only new review-labelled tasks
      // participate in the ephemeral-review experiment.
      persistThread: Boolean(resumeThreadId) || request.label !== "review",
      turnTimeoutMs: request.turnTimeoutMs,
      hardCeilingMs: request.hardCeilingMs,
      threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT, request.label)
    });
  } finally {
    releaseScratchLock?.();
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    ephemeral: !resumeThreadId && request.label === "review",
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    // Only present for --scratch-sandbox: the sandbox policy the app-server
    // actually resolved for the run (see validateScratchSandboxThreadStart),
    // not just what was requested — surfaced via `result --json` per
    // code-review finding IMPORTANT #7.
    ...(sandboxEffective ? { sandboxEffective } : {})
  };
  // Only attempted when the caller actually asked for structured output —
  // reusing the same parser adversarial-review's turn/start already uses
  // (parseStructuredOutput), rather than a second ad-hoc JSON.parse. Without
  // --output-schema the payload gains no new keys, so plain `task` runs stay
  // byte-for-byte unchanged.
  if (request.outputSchema) {
    const structuredResult = parseStructuredOutput(rawOutput, { failureMessage: failureMessage || null });
    payload.structured = structuredResult.parsed;
    payload.structuredError = structuredResult.parseError;
  }

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    // A turn that legitimately fails (the app-server rejects the model's
    // output against --output-schema in strict mode, for example) returns
    // here rather than throwing — exitStatus is just non-zero. Without this,
    // runTrackedJob's success branch (see tracked-jobs.mjs) never persisted
    // an errorMessage on the job at all, unlike a thrown precondition error,
    // and `result` silently fell back to nothing useful to show. When the
    // turn failed but left no failureMessage of its own (no app-server
    // "error" notification, no stderr), fall back to a synthetic one instead
    // of null — see describeUnexplainedTaskFailure above.
    errorMessage: result.status === 0 ? null : failureMessage || describeUnexplainedTaskFailure(result),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

// The spawn text is the only thing the calling agent ever receives: the rescue
// subagent forwards this stdout verbatim and its contract forbids it to poll,
// fetch results, or follow up. "Started in the background" alone therefore
// reads exactly like an empty answer, and that is how finished runs were left
// uncollected. So the launch has to say the answer is not here yet and carry
// the one command that fetches it.
//
// That command must be run as its OWN background tool call (Claude Code:
// `Bash` with `run_in_background: true`), not awaited inline — inline it just
// reproduces the same host Bash-tool timeout `task --background` was started
// to avoid. Run in the background, the host delivers exactly one notification
// when `wait` exits, and the answer is already sitting in that call's stdout
// — no separate poll-then-fetch round trip, and no window where a forwarder's
// own completion (see codex-result-handling's "the subagent finished is not
// the answer") gets mistaken for Codex's.
// The `WAIT: ` prefix is a stable extraction marker, not decoration: a caller
// parsing this text (codex:rescue's forwarding contract — see rescue.md) must
// find the command by a fixed anchor, not by "the last non-empty line before
// the blank line", which broke the moment an explanatory line was added after
// it (code-review finding #3). `--json` callers don't need the marker at
// all — `payload.waitCommand` is already the single unambiguous field there.
function renderQueuedTaskLaunch(payload) {
  return [
    `${payload.title} started in the background as ${payload.jobId}.`,
    "This is NOT the answer: Codex is still working, and nothing further arrives on its own.",
    "To collect it, run the WAIT command below as a BACKGROUND tool call (e.g. Claude Code: Bash with run_in_background: true) — you get exactly one notification, and the answer is already in its stdout when it fires. It blocks until the job leaves queued/running, then prints the answer; raise --timeout-ms for a longer run.",
    `WAIT: ${payload.waitCommand}`,
    ""
  ].join("\n");
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, readOnly, scratchSandbox, resumeLast, label, jobId, turnTimeoutMs, hardCeilingMs, outputSchema }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    readOnly,
    scratchSandbox,
    resumeLast,
    label,
    jobId,
    turnTimeoutMs,
    hardCeilingMs,
    // Only present when a schema was actually requested. This request object
    // is what a background job persists as storedJob.request (see
    // enqueueBackgroundTask/handleTaskWorker below) — an unconditional
    // `outputSchema: null` here would show up as a new key on every
    // background task's stored job, schema or not.
    ...(outputSchema ? { outputSchema } : {})
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

// Resolve the per-turn IDLE timeout from CLI options. Precedence:
//   --turn-timeout-ms flag > CODEX_TURN_TIMEOUT_MS env > foreground/background default.
// This is how long the turn may go silent (no turn/started, item/started,
// item/completed, or in-item progress/delta notification) before it's
// considered dead — NOT a budget for the turn's total duration. A turn that
// keeps producing events can run far longer than this value without being
// killed; see resolveTurnHardCeilingMsFromOptions below (and
// DEFAULT_HARD_WALL_CLOCK_CEILING_MS in lib/codex.mjs) for the separate
// wall-clock backstop on that case — generous in the background, but equal to
// this foreground budget in the foreground, where it must stay under the host kill.
// Foreground default is just under the Bash-tool ceiling (110s) so a stalled turn
// returns a structured error instead of being SIGKILLed. Background gets the full
// 600s default (no external ceiling to collide with).
function resolveTurnTimeoutMsFromOptions(options) {
  const explicit = Number(options["turn-timeout-ms"]);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fromEnv = Number(process.env.CODEX_TURN_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return options.background ? DEFAULT_TURN_TIMEOUT_MS : FOREGROUND_TURN_TIMEOUT_MS;
}

// Resolve the hard wall-clock ceiling (see DEFAULT_TURN_HARD_CEILING_MS).
// Precedence mirrors resolveTurnTimeoutMsFromOptions: env override first (for
// tests and non-Claude hosts with a different external ceiling), then the
// foreground/background default. There is no CLI flag — the ceiling is a
// safety property of the host, not something a caller should tune per-run.
function resolveTurnHardCeilingMsFromOptions(options) {
  const fromEnv = Number(process.env.CODEX_TURN_HARD_CEILING_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return options.background ? DEFAULT_TURN_HARD_CEILING_MS : FOREGROUND_TURN_TIMEOUT_MS;
}

// Reads the prompt but does NOT delete a one-shot `--prompt-file`: deletion
// only happens once the task this prompt is for has actually been accepted —
// see the `consumeOneShotPromptFile` calls in handleTask below, and the
// comment there for why deletion cannot live here. The read itself does
// still happen exactly once, before `task` branches into foreground vs
// `--background`: the text (not the path) is what ends up in the job
// request, so a detached worker never re-reads this file regardless of which
// branch runs next.
function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    const promptFilePath = path.resolve(cwd, options["prompt-file"]);
    return { prompt: fs.readFileSync(promptFilePath, "utf8"), promptFilePath };
  }

  const positionalPrompt = positionals.join(" ");
  return { prompt: positionalPrompt || readStdinIfPiped(), promptFilePath: null };
}

// Reads and parses `--output-schema` exactly once, up front — same shape as
// readTaskPrompt above: the parsed schema object (not the path) is what ends
// up in the job request, so a detached background worker never re-reads this
// file. A missing or malformed schema throws BEFORE the job is created (or,
// in the foreground, before Codex is even asked to run), so a bad path never
// costs the caller a queued job or a spent turn — and, per the same
// precondition-vs-acceptance split readTaskPrompt's comment documents, this
// runs before any `--prompt-file` is consumed, so a rejected schema leaves
// the one-shot prompt file in place for a retry.
function readTaskOutputSchema(cwd, options) {
  if (!options["output-schema"]) {
    return null;
  }
  const schemaPath = path.resolve(cwd, options["output-schema"]);
  try {
    return readOutputSchema(schemaPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read --output-schema ${schemaPath}: ${detail}`);
  }
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

// Quote only what needs it: the caller pastes this straight into a shell.
// The printed command is meant to be pasted verbatim into a shell tool — on
// Windows that is usually Git Bash, where an unquoted `C:\Users\...` loses
// every backslash (`\U` -> `U`) and the command silently points nowhere.
// Forward slashes are understood by node, bash, PowerShell and cmd alike, so
// Windows paths are printed with them instead of relying on quoting.
function formatCommandPart(part, platform = process.platform) {
  const text = platform === "win32" ? String(part).replace(/\\/g, "/") : String(part);
  return /[\s"']/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function buildCompanionCommand(args) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  return ["node", scriptPath, ...args].map((part) => formatCommandPart(part)).join(" ");
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      waitCommand: buildCompanionCommand(["wait", job.id, "--cwd", cwd])
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  announceRun(model, effort);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        focusText,
        reviewName: config.reviewName,
        turnTimeoutMs: resolveTurnTimeoutMsFromOptions(options),
        hardCeilingMs: resolveTurnHardCeilingMsFromOptions(options),
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "output-schema", "turn-timeout-ms", "label"],
    booleanOptions: ["json", "write", "read-only", "scratch-sandbox", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveTaskCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  announceRun(model, effort);
  const { prompt, promptFilePath } = readTaskPrompt(cwd, options, positionals);
  // Read and parse up front, same as the prompt file: a bad --output-schema
  // must fail BEFORE a background job is queued or a foreground turn is
  // spent, and before promptFilePath is ever consumed below.
  const outputSchema = readTaskOutputSchema(cwd, options);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const readOnly = Boolean(options["read-only"]);
  if (write && readOnly) {
    throw new Error("Choose either --write or --read-only.");
  }
  // --scratch-sandbox is a self-contained sandbox mode, not a modifier of
  // --write/--read-only: it already implies the repository is read-only (the
  // scratch directory is the sole writable root), so it takes neither flag.
  // --write is a straightforward contradiction (write to the repository vs.
  // keep it read-only). --read-only is not a contradiction in EFFECT — the
  // repository ends up read-only either way — but it IS one in MECHANISM:
  // plain --read-only pins the Codex sandbox itself to read-only, while
  // --scratch-sandbox pins it to workspace-write (rooted at scratch) and
  // gets the repository's read-only-ness from writableRoots instead. Passing
  // both asks for two different sandbox modes on the same thread, so it is
  // refused rather than silently picking one.
  const scratchSandbox = Boolean(options["scratch-sandbox"]);
  if (scratchSandbox && write) {
    throw new Error("Choose either --write or --scratch-sandbox (--scratch-sandbox keeps the repository read-only; only the scratch directory is writable).");
  }
  if (scratchSandbox && readOnly) {
    throw new Error("--scratch-sandbox is a self-contained sandbox mode and already keeps the repository read-only; do not combine it with --read-only.");
  }
  // A fresh thread only: thread/resume keeps a loaded thread's own sandbox
  // policy and ignores most of what --scratch-sandbox overrides (see
  // codex.mjs's runAppServerTurn and validateScratchSandboxThreadStart in
  // lib/scratch-sandbox.mjs), so the guarantee the flag makes — repository
  // read-only, scratch the sole writable root — cannot actually be kept on a
  // resumed thread. Refused here, before any prompt is sent or app-server
  // connection is made; runAppServerTurn also refuses the combination itself
  // as a second guard for any other caller.
  if (scratchSandbox && resumeLast) {
    throw new Error("--scratch-sandbox only supports a fresh task; it cannot be combined with --resume/--resume-last.");
  }
  // Names the thread in the Codex app's session list. Closed set, because the
  // prefix doubles as the lookup key for --resume-last (see lib/task-thread.mjs).
  const label = normalizeTaskLabel(options.label);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      readOnly,
      scratchSandbox,
      resumeLast,
      label,
      jobId: job.id,
      turnTimeoutMs: resolveTurnTimeoutMsFromOptions(options),
      hardCeilingMs: resolveTurnHardCeilingMsFromOptions(options),
      outputSchema
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    // Only past this point is the task actually accepted: the job is
    // durably queued and a detached worker has been spawned to run it. Every
    // check above (flag conflicts, Codex availability, an empty prompt with
    // no --resume-last) can still throw, and a thrown error skips this line
    // entirely — leaving a one-shot prompt file in place is exactly what we
    // want when the task was never accepted.
    if (promptFilePath) {
      safelyConsumeOneShotPromptFile(cwd, promptFilePath);
    }
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        readOnly,
        scratchSandbox,
        resumeLast,
        label,
        jobId: job.id,
        turnTimeoutMs: resolveTurnTimeoutMsFromOptions(options),
        hardCeilingMs: resolveTurnHardCeilingMsFromOptions(options),
        outputSchema,
        onProgress: progress
      }),
    { json: options.json }
  );
  // executeTaskRun's own preconditions — Codex availability, resolving
  // --resume-last to an actual thread, "provide a prompt" — throw inside the
  // runner. runTrackedJob catches that, marks the job failed, and rethrows;
  // runForegroundCommand does not swallow it, so the `await` above rejects
  // and this line is never reached. Only a run that genuinely executed
  // (successfully or with a Codex-side failure reflected in exitStatus, not
  // a thrown precondition error) reaches here and consumes the prompt file.
  if (promptFilePath) {
    safelyConsumeOneShotPromptFile(cwd, promptFilePath);
  }
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = await waitForStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    return;
  }
  if (storedJob.status === "cancelled") {
    appendLogLine(storedJob.logFile, "Skipped cancelled background job.");
    return;
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  registerWorkerCrashGuard(workspaceRoot, options["job-id"], logFile);
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

// Collapses `status <id> --wait` + `result <id>` into one call the caller can
// hand straight to a BACKGROUND tool call (Claude Code: `Bash` with
// `run_in_background: true`): the host delivers exactly one notification when
// that call exits, and by then the answer is already in this command's
// stdout. Splitting collection across two Bash calls (the previous contract)
// meant a forwarding subagent's launch text was the only thing the calling
// agent ever saw — see renderQueuedTaskLaunch — and "the subagent finished"
// was indistinguishable from "Codex answered". See job-control.mjs for the
// reconcile (dead worker / broker restart -> failed) that `wait` inherits for
// free through buildSingleJobSnapshot/listJobs, same as `status --wait`.
//
// Exit codes: 0 completed, 1 failed/cancelled (stdout carries the reason), 2
// still queued/running when --timeout-ms ran out (not an error — the job is
// still alive, retry the same command).
// Preserves exactly the flags the caller actually passed (plus --cwd, always
// needed since a retry is a fresh process with no cwd to inherit). A retry
// line that dropped the caller's own --timeout-ms/--json would silently hand
// back the 30-minute default and plain text even when the caller asked for
// neither — code-review finding #2 on the first cut of this command.
function buildWaitRetryArgs(jobId, cwd, options) {
  const args = ["wait", jobId, "--cwd", cwd];
  if (options["timeout-ms"] != null) {
    args.push("--timeout-ms", String(options["timeout-ms"]));
  }
  if (options["poll-interval-ms"] != null) {
    args.push("--poll-interval-ms", String(options["poll-interval-ms"]));
  }
  if (options.json) {
    args.push("--json");
  }
  return args;
}

async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw new Error("`wait` requires a job id.");
  }

  const timeoutMs = resolveExplicitTimeoutMs(options["timeout-ms"], BACKGROUND_COLLECT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options["poll-interval-ms"]) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  // ONE deadline for the whole call, not two independent budgets stacked back
  // to back — code-review finding #1: a caller passing a short --timeout-ms
  // (say, to bound a retry loop of its own) must actually get bounded by it,
  // including the time spent surviving the job-index race below. The index
  // wait gets whichever is smaller: its own bounded default/override, or
  // whatever is left of the caller's total budget.
  const deadline = Date.now() + timeoutMs;

  // First, survive the job-index race (see waitForJobToAppear). Once the job
  // is actually known, waitForSingleJobSnapshot's own lookup will find it
  // every time, so reusing it here does not reintroduce that race.
  const indexRetryBudgetMs = Math.min(resolveWaitJobIndexRetryMs(), Math.max(0, deadline - Date.now()));
  const appeared = await waitForJobToAppear(cwd, reference, { pollIntervalMs, retryBudgetMs: indexRetryBudgetMs });
  const remainingMs = Math.max(0, deadline - Date.now());
  let waited;
  if (!isActiveJobStatus(appeared.job.status)) {
    waited = { ...appeared, waitTimedOut: false, timeoutMs: remainingMs };
  } else if (remainingMs <= 0) {
    // waitForSingleJobSnapshot treats a falsy timeoutMs (0 included — `0 ||
    // DEFAULT` is truthy in JS) as "use the 240s default", which would blow
    // straight past the deadline this call just spent its whole budget
    // reaching. An already-exhausted budget is a timeout outright, not a
    // reason to poll once more.
    waited = { ...appeared, waitTimedOut: true, timeoutMs: remainingMs };
  } else {
    waited = await waitForSingleJobSnapshot(cwd, reference, { timeoutMs: remainingMs, pollIntervalMs });
  }

  const { workspaceRoot, job } = waited;

  if (isActiveJobStatus(job.status)) {
    const retryCommand = buildCompanionCommand(buildWaitRetryArgs(job.id, cwd, options));
    const message = `${job.id} has not finished yet (${job.status}). Retry: ${retryCommand}\n`;
    if (options.json) {
      outputResult({ status: "timeout", job, retryCommand }, true);
    } else {
      process.stdout.write(message);
    }
    process.exitCode = 2;
    return;
  }

  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };
  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
  if (job.status !== "completed") {
    process.exitCode = 1;
  }
}

// Prompt files older than this are swept whenever we touch the directory
// (both `prompt-path` handing out a new one and `task` consuming one). The
// runtime deletes a prompt file itself right after `task --prompt-file`
// reads it (see consumeOneShotPromptFile below); this sweep is the backstop
// for whatever a deletion attempt could not clean up — a file left behind by
// a crashed or cancelled run, a permissions race, a caller that generated a
// path but never came back to use it.
const PROMPT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Matches exactly the names `generatePromptFilePath` produces:
// `<sanitized-label>-<uuidv4>.md`. The age sweep and the one-shot delete
// only ever touch files matching this, so a caller's own unrelated file
// dropped into the same directory is never removed, stale or not.
const PROMPT_FILE_NAME_PATTERN =
  /^[a-zA-Z0-9._-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

function resolvePromptsDir(cwd) {
  return path.join(resolveStateDir(cwd), "prompts");
}

// Windows paths that refer to the same file can differ in case (drive letter
// most commonly: `c:\...` vs `C:\...`) without being different paths on
// disk — NTFS is case-preserving but case-insensitive. Everywhere else, case
// is significant. path.normalize first so a trailing separator or repeated
// separators cannot masquerade as a case difference.
function pathsEqualForOwnership(a, b) {
  if (process.platform !== "win32") {
    return a === b;
  }
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

// Whether real path `child` is (strictly) inside real path `parent`. Both
// must already be resolved with fs.realpathSync — this does no filesystem
// access itself, just a path comparison, case-insensitive on win32 to match
// pathsEqualForOwnership above.
function isRealPathInside(parentReal, childReal) {
  if (pathsEqualForOwnership(parentReal, childReal)) {
    return false;
  }
  const parent = process.platform === "win32" ? path.normalize(parentReal).toLowerCase() : parentReal;
  const child = process.platform === "win32" ? path.normalize(childReal).toLowerCase() : childReal;
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}

// Verifies the prompts directory is what it is supposed to be before
// anything reads, writes, or deletes through it: not a symlink, not a
// Windows junction (Node's fs reports those as symbolic links too — same
// lstat check catches both), a real directory, and its realpath actually
// lands inside the state directory's realpath rather than some place a
// symlinked ancestor or a stale mount redirected it to. A prompt file can
// carry whatever a caller pasted into a rescue request — paths, log
// excerpts, snippets that might include client data — so silently trusting
// a redirected directory is never an acceptable default.
//
// Returns `{ promptsDir, exists: false }` when nothing is there yet (not a
// problem — callers that create it, like prompt-path, proceed normally);
// `{ promptsDir, exists: true, unsafe: "<reason>" }` when something exists
// but isn't trustworthy; or `{ promptsDir, exists: true, realPromptsDir }`
// once it has been confirmed safe to use.
function resolveVerifiedPromptsDir(cwd) {
  const promptsDir = resolvePromptsDir(cwd);

  let entryStats;
  try {
    entryStats = fs.lstatSync(promptsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { promptsDir, exists: false };
    }
    return { promptsDir, exists: true, unsafe: `could not inspect ${promptsDir}: ${error.message}` };
  }

  if (entryStats.isSymbolicLink()) {
    return { promptsDir, exists: true, unsafe: `${promptsDir} is a symlink or junction, refusing to use it as the prompts directory` };
  }
  if (!entryStats.isDirectory()) {
    return { promptsDir, exists: true, unsafe: `${promptsDir} exists but is not a directory` };
  }

  const stateDir = resolveStateDir(cwd);
  let realPromptsDir;
  let realStateDir;
  try {
    realPromptsDir = fs.realpathSync(promptsDir);
    realStateDir = fs.realpathSync(stateDir);
  } catch (error) {
    return { promptsDir, exists: true, unsafe: `could not resolve the real path of ${promptsDir}: ${error.message}` };
  }

  if (!isRealPathInside(realStateDir, realPromptsDir)) {
    return {
      promptsDir,
      exists: true,
      unsafe: `${promptsDir} resolves to ${realPromptsDir}, which is outside its expected state directory ${realStateDir}`
    };
  }

  return { promptsDir, exists: true, realPromptsDir };
}

// Mirrors the workspace-slug sanitizer in lib/state.mjs: keep the label
// filesystem-safe and fall back to a fixed word rather than reject a caller's
// free-text label outright.
function sanitizePromptLabel(label) {
  const trimmed = String(label ?? "").trim();
  const slug = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "task";
}

// POSIX: owner-only (0o700). A prompt file can carry whatever the caller
// pasted into a rescue request — paths, log excerpts, snippets that might
// include client data — so the directory holding it should not be
// world/group-readable. Fail-closed: if we cannot narrow it, throw rather
// than silently keep serving prompt files from a directory whose real
// permissions we don't know. On Windows, ACL inheritance from the parent
// plugin data directory is left as-is (chmod's owner/group/other bits do not
// map onto Windows ACLs) — `consumeOneShotPromptFile` below cuts the file's
// on-disk lifetime to seconds (deleted right after `task` reads it), which
// stands in for directory-level isolation there instead.
function ensurePromptsDir(promptsDir) {
  fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(promptsDir, 0o700);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not restrict prompts directory ${promptsDir} to owner-only (0700): ${detail}`);
  }
}

// Low-level sweep: assumes `promptsDir` has already been through
// resolveVerifiedPromptsDir and is safe to read and delete from. Callers
// (generatePromptFilePath, consumeOneShotPromptFile) verify first and pass
// the confirmed `promptsDir`; never call this on an unverified path.
function unlinkStalePromptFiles(promptsDir, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(promptsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !PROMPT_FILE_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const filePath = path.join(promptsDir, entry.name);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stats.mtimeMs > PROMPT_FILE_MAX_AGE_MS) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort: a file removed or locked between readdir and unlink
        // is not this command's problem to report.
      }
    }
  }
}

// Prints the path a caller should Write its prompt text to, then pass back as
// `task --prompt-file <path>`. Deliberately does NOT create the file: Claude
// Code's Write tool refuses to overwrite a path it has not read, so handing
// back an already-existing (even empty) file would make the very next step
// fail.
//
// Fail-closed on the prompts directory itself: unlike the cleanup path in
// consumeOneShotPromptFile (pure housekeeping, must never break an
// already-accepted task — see safelyConsumeOneShotPromptFile), handing out a
// path is the one place where writing a prompt — which can carry client
// data — through a symlinked, junctioned, or otherwise wrong directory must
// be refused outright rather than silently tolerated.
function generatePromptFilePath(cwd, label) {
  const preCreateVerification = resolveVerifiedPromptsDir(cwd);
  if (preCreateVerification.exists && preCreateVerification.unsafe) {
    throw new Error(`Refusing to hand out a prompt file path: ${preCreateVerification.unsafe}`);
  }

  ensurePromptsDir(preCreateVerification.promptsDir);

  // mkdirSync recursive is a no-op when the path already exists, so the
  // pre-create check above is what actually guards against a pre-existing
  // symlink/junction. Re-verifying after creation catches the (much
  // narrower) case where the directory changed underneath us between the
  // two calls.
  const verified = resolveVerifiedPromptsDir(cwd);
  if (!verified.exists || verified.unsafe) {
    throw new Error(`Refusing to hand out a prompt file path: ${verified.unsafe ?? "the prompts directory disappeared right after creation"}`);
  }

  unlinkStalePromptFiles(verified.promptsDir);

  const slug = sanitizePromptLabel(label);
  const id = crypto.randomUUID();
  return path.join(verified.promptsDir, `${slug}-${id}.md`);
}

function handlePromptPath(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "label"],
    booleanOptions: ["json"]
  });

  const cwd = resolveTaskCwd(options);
  const filePath = generatePromptFilePath(cwd, options.label);
  outputCommandResult({ path: filePath }, `${filePath}\n`, options.json);
}

// Whether `promptFilePath` is a file this runtime itself handed out via
// `prompt-path` — and is therefore ours to delete. `verifiedPromptsDir` must
// already be a *safe* result from resolveVerifiedPromptsDir (checked once by
// the caller, not re-checked per file). Three independent checks on the file
// itself, all required, because each guards against a different way a path
// could look "close enough" without actually being our file:
//   - name pattern: only `<label>-<uuid>.md` is a shape `prompt-path` would
//     have generated. Guards a caller's own file dropped into the same
//     directory under a name we did not choose.
//   - lstat on the ORIGINAL (unresolved) path: if the path itself is a
//     symlink, refuse it. Deleting through a symlink whose target we did not
//     verify could delete something outside the prompts directory entirely.
//   - realpath containment: resolve the file through the filesystem (not
//     string prefix matching) and require its real parent to equal the
//     already-verified real prompts directory exactly — one level, not a
//     subdirectory.
function isOwnedPromptFile(promptFilePath, verifiedPromptsDir) {
  if (!PROMPT_FILE_NAME_PATTERN.test(path.basename(promptFilePath))) {
    return false;
  }

  let entryStats;
  let realFilePath;
  try {
    entryStats = fs.lstatSync(promptFilePath);
    realFilePath = fs.realpathSync(promptFilePath);
  } catch {
    // Missing or unreadable — not ours to touch.
    return false;
  }

  if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
    return false;
  }

  return pathsEqualForOwnership(path.dirname(realFilePath), verifiedPromptsDir.realPromptsDir);
}

// A prompt file handed out by `prompt-path` is single-use: once `task` has
// read it, nothing else ever will. Deleting it immediately — rather than
// waiting for the next `prompt-path` call's age sweep, which could be days
// away — bounds how long a prompt that may carry client data sits on disk.
// Only files this runtime actually owns (see isOwnedPromptFile) are removed;
// a caller's own file passed via `--prompt-file` from somewhere else, or a
// same-directory file we did not generate, is never touched. If the prompts
// directory itself doesn't verify as safe (see resolveVerifiedPromptsDir),
// neither the delete nor the sweep below runs — warn and leave everything
// as-is rather than delete through a symlink/junction we didn't expect.
// Also re-runs the age sweep here (not just from `prompt-path`), so a
// directory that only ever sees `task` calls — never a fresh `prompt-path`
// in between — still gets swept.
function consumeOneShotPromptFile(cwd, promptFilePath) {
  const verified = resolveVerifiedPromptsDir(cwd);

  if (verified.exists && verified.unsafe) {
    process.stderr.write(`Warning: skipping prompt file cleanup: ${verified.unsafe}\n`);
    return;
  }

  if (verified.exists && isOwnedPromptFile(promptFilePath, verified)) {
    try {
      fs.unlinkSync(promptFilePath);
    } catch {
      // Best-effort: already gone, or a permissions/locking race. The age
      // sweep below (and the next prompt-path call) is the backstop.
    }
  }

  if (verified.exists) {
    unlinkStalePromptFiles(verified.promptsDir);
  }
}

// Cleanup must never change the outcome of an already-accepted task. By the
// time either call site below runs, the job is durably queued (background)
// or the run already executed (foreground) — the caller's jobId and exit
// code have to reflect THAT, not whatever happened to the housekeeping
// afterwards. Letting an unexpected cleanup exception reach main()'s catch
// handler would turn an accepted task into a reported failure with no
// jobId — and the caller's natural response, retry, would create a
// duplicate job for work that already started. So: catch, warn on stderr,
// move on. (consumeOneShotPromptFile itself already warns-and-returns for
// the specific "prompts directory looks wrong" case; this is the backstop
// for anything else that slips through.)
function safelyConsumeOneShotPromptFile(cwd, promptFilePath) {
  try {
    consumeOneShotPromptFile(cwd, promptFilePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: could not clean up prompt file ${promptFilePath}: ${detail}\n`);
  }
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveTaskCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs, { excludeDeadWorkerFailures: true });

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const completedAt = nowIso();
  const cancellingJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt,
    errorMessage: "Cancelled by user."
  };
  const persistCancellation = (pid) => {
    const cancelledJob = { ...cancellingJob, pid };
    writeJobFile(workspaceRoot, job.id, {
      ...existing,
      ...cancelledJob,
      cancelledAt: completedAt
    });
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid,
      errorMessage: "Cancelled by user.",
      completedAt
    });
    return cancelledJob;
  };

  const isOrphan = isOrphanedTurn(job);

  // An orphaned job has no local pid to fall back on — the remote interrupt is
  // the ONLY mechanism that can actually stop it, so cancellation must not be
  // persisted until that interrupt is confirmed. Do this BEFORE the optimistic
  // persistCancellation() below: interruptAppServerTurn is bounded (see
  // DEFAULT_INTERRUPT_TIMEOUT_MS), but persisting "cancelled" first and rolling
  // back only after the await returns leaves a false-cancelled state on disk if
  // the process is killed or crashes while still awaiting it.
  if (isOrphan) {
    const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId, archiveThread: true });
    if (interrupt.attempted) {
      appendLogLine(
        job.logFile,
        interrupt.interrupted
          ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
          : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
      );
    }
    if (!interrupt.interrupted) {
      const detail = interrupt.detail ? `: ${interrupt.detail}` : ".";
      const message = `${CANCELLATION_INTERRUPT_REQUIRED_MESSAGE}${detail}`;
      appendLogLine(job.logFile, message);
      throw new Error(message);
    }
    const nextJob = persistCancellation(null);
    appendLogLine(job.logFile, "Cancelled by user.");
    // У осиротевшей задачи worker'а нет вовсе — тред убрал сам interrupt.
    if (interrupt.archived) {
      upsertJob(cwd, { id: job.id, threadArchived: true });
    }
    const payload = {
      jobId: job.id,
      status: "cancelled",
      title: job.title,
      turnInterruptAttempted: interrupt.attempted,
      turnInterrupted: interrupt.interrupted
    };
    outputCommandResult(payload, renderCancelReport(nextJob), options.json);
    return;
  }

  persistCancellation(job.pid ?? null);
  appendLogLine(job.logFile, "Cancelled by user.");

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId, archiveThread: true });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  let termination = null;
  let terminationError = null;
  try {
    termination = terminateProcessTree(job.pid ?? Number.NaN);
  } catch (error) {
    terminationError = error;
  }

  const outcome = settleCancellationAfterTermination(
    workspaceRoot,
    job,
    existing,
    termination,
    terminationError
  );
  if (!outcome.processStopped) {
    appendLogLine(job.logFile, outcome.job.errorMessage);
    throw outcome.error;
  }

  const nextJob = persistCancellation(null);

  // terminateProcessTree выше убил worker, а значит его finally с архивацией
  // треда не выполнится никогда — тред убрал interrupt тем же соединением.
  if (interrupt.archived) {
    upsertJob(cwd, { id: job.id, threadArchived: true });
  }

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "prompt-path":
      handlePromptPath(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "wait":
      await handleWait(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
