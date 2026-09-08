#!/usr/bin/env node

import { spawn } from "node:child_process";
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
import { buildPersistentTaskThreadName, DEFAULT_CONTINUE_PROMPT, normalizeTaskLabel, TASK_THREAD_LABELS } from "./lib/task-thread.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
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

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--read-only] [--cwd <dir>] [--resume-last|--resume|--fresh] [--label <task|review|rescue>] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
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

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
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
    persistThread: true,
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

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : request.readOnly ? "read-only" : null,
    onProgress: request.onProgress,
    persistThread: true,
    turnTimeoutMs: request.turnTimeoutMs,
    hardCeilingMs: request.hardCeilingMs,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT, request.label)
  });

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
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
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
// the two commands that fetch it. A slash command will not do — those are for
// the human; the caller cannot invoke one.
function renderQueuedTaskLaunch(payload) {
  return [
    `${payload.title} started in the background as ${payload.jobId}.`,
    "This is NOT the answer: Codex is still working, and nothing further arrives on its own.",
    "To collect it, block until the run finishes:",
    `  ${payload.waitCommand}`,
    "then read the answer:",
    `  ${payload.resultCommand}`,
    "(--wait polls until the job leaves queued/running; raise --timeout-ms for a longer run.)",
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

function buildTaskRequest({ cwd, model, effort, prompt, write, readOnly, resumeLast, label, jobId, turnTimeoutMs, hardCeilingMs }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    readOnly,
    resumeLast,
    label,
    jobId,
    turnTimeoutMs,
    hardCeilingMs
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

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
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
function buildCompanionCommand(args) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  return ["node", scriptPath, ...args]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
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
      waitCommand: buildCompanionCommand([
        "status",
        job.id,
        "--wait",
        "--timeout-ms",
        String(BACKGROUND_COLLECT_TIMEOUT_MS),
        "--cwd",
        cwd
      ]),
      resultCommand: buildCompanionCommand(["result", job.id, "--cwd", cwd])
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
    valueOptions: ["model", "effort", "cwd", "prompt-file", "turn-timeout-ms", "label"],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveTaskCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  announceRun(model, effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

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
      resumeLast,
      label,
      jobId: job.id,
      turnTimeoutMs: resolveTurnTimeoutMsFromOptions(options),
      hardCeilingMs: resolveTurnHardCeilingMsFromOptions(options)
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
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
        resumeLast,
        label,
        jobId: job.id,
        turnTimeoutMs: resolveTurnTimeoutMsFromOptions(options),
        hardCeilingMs: resolveTurnHardCeilingMsFromOptions(options),
        onProgress: progress
      }),
    { json: options.json }
  );
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

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveTaskCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

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
