import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { registerPluginDataDir, writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok", version = "codex-cli test") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
		const BEHAVIOR = ${JSON.stringify(behavior)};
		const VERSION = ${JSON.stringify(version)};
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null, lastAppServerSpawnArgs: null, lastReviewStart: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    // Real codex (0.146.0) records EVERY app-server thread as "vscode" — the
    // kind comes from the transport, not from clientInfo. The fixture said
    // "appServer", which is why a lookup filtered on sourceKinds:["appServer"]
    // passed here and matched nothing in production.
    source: "vscode",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
	    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
	        origins: {}
	      };
	    case "custom-provider":
	      return {
	        config: { model_provider: "custom" },
	        origins: {}
	      };
	    case "inherited-sol-max":
	      return {
	        config: { model_provider: "openai", model: "gpt-5.6-sol", model_reasoning_effort: "max" },
	        origins: {}
	      };
	    case "inherited-luna-ultra":
	      return {
	        config: { model_provider: "openai", model: "gpt-5.6-luna", model_reasoning_effort: "ultra" },
	        origins: {}
	      };
	    case "inherited-default-luna-ultra":
	      return {
	        config: { model_provider: "openai", model_reasoning_effort: "ultra" },
	        origins: {}
	      };
	    case "config-luna":
	      return {
	        config: { model_provider: "openai", model: "gpt-5.6-luna", model_reasoning_effort: "high" },
	        origins: {}
	      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
	  console.log(VERSION);
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
bootState.lastAppServerSpawnArgs = args;
saveState(bootState);

// app-server-self-exit: simulate the app-server child dying after the
// initialize handshake. Death is ACK-based — the fake exits on the
// initialized notification (after the initialize reply flushed), NOT on a
// boot-relative timer. A boot timer raced the broker listen/exitPromise-arm
// step and flaked under load; the ACK guarantees ordering.


const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        if (BEHAVIOR === "stalled-initialize") {
          // Never respond — simulates a spawned app-server that is alive (stdin
          // open) but wedged on initialize. SpawnedCodexAppServerClient.initialize()
          // must bound this handshake (fork #31) instead of hanging forever.
          break;
        }
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        if (BEHAVIOR === "app-server-self-exit") {
          process.exit(1);
        }
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
	        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
	        const inheritedSelection = BEHAVIOR === "inherited-sol-max"
	          ? { model: "gpt-5.6-sol", effort: "max" }
	          : BEHAVIOR === "inherited-luna-ultra"
	            ? { model: "gpt-5.6-luna", effort: "ultra" }
	            : BEHAVIOR === "inherited-default-luna-ultra"
              ? { model: "gpt-5.6-luna", effort: "ultra" }
	            : null;
	        const selectedModel = message.params.model || inheritedSelection?.model || "gpt-5.4";
	        const selectedEffort = BEHAVIOR === "resolved-effort"
	          ? "medium"
	          : message.params.config?.model_reasoning_effort || inheritedSelection?.effort || null;
	        const modelProvider = BEHAVIOR === "custom-provider" ? "custom" : "openai";
	        thread.model = selectedModel;
	        thread.reasoningEffort = selectedEffort;
	        state.lastThreadStart = {
	          model: selectedModel,
	          effort: selectedEffort,
	          config: message.params.config ?? null,
	          sandbox: message.params.sandbox ?? null
	        };
	        saveState(state);
	        send({ id: message.id, result: { thread: buildThread(thread), model: selectedModel, modelProvider, serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: selectedEffort } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/archive": {
        const thread = ensureThread(state, message.params.threadId);
        thread.archived = true;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/unarchive": {
        const thread = ensureThread(state, message.params.threadId);
        if (!thread.archived) {
          throw new Error("session " + thread.id + " is not archived");
        }
        thread.archived = false;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        threads = message.params.archived === true
          ? threads.filter((thread) => thread.archived === true)
          : threads.filter((thread) => thread.archived !== true);
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        if (thread.archived) {
          throw new Error("session " + thread.id + " is archived. Run codex unarchive " + thread.id + " to unarchive it first.");
        }
        thread.updatedAt = now();
        saveState(state);
	        const selectedModel = message.params.model || thread.model || "gpt-5.4";
	        const selectedEffort = BEHAVIOR === "inherited-sol-max" ? "max" : thread.reasoningEffort || null;
	        state.lastThreadResume = {
	          model: selectedModel,
	          effort: selectedEffort,
	          sandbox: message.params.sandbox ?? null
	        };
	        saveState(state);
	        // resume-ignores-sandbox: simulate a real Codex app-server that keeps a
	        // loaded thread's sandbox and ignores the thread/resume override — so an
	        // explicit --read-only pin on a write-capable thread is silently lost.
	        const resumeSandbox = BEHAVIOR === "resume-ignores-sandbox"
	          ? { type: "workspaceWrite", writableRoots: [], networkAccess: false }
	          : { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
	        send({ id: message.id, result: { thread: buildThread(thread), model: selectedModel, modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: resumeSandbox, reasoningEffort: selectedEffort } });
	        break;
      }

	      case "model/list": {
	        if (BEHAVIOR === "model-list-unsupported") {
	          send({ id: message.id, error: { code: -32601, message: "Unsupported method: model/list" } });
	          break;
	        }
	        const model = (name, efforts) => ({
	          id: name,
	          model: name,
	          isDefault: BEHAVIOR === "inherited-default-luna-ultra" && name === "gpt-5.6-luna",
	          hidden: false,
	          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
	        });
	        send({
	          id: message.id,
	          result: {
	            data: [
	              model("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
	              model("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]),
	              model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"])
	            ],
	            nextCursor: null
	          }
	        });
	        break;
	      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        state.lastReviewStart = {
          threadId: message.params.threadId,
          reviewThreadId: reviewThread.id,
          model: message.params.model ?? null,
          effort: message.params.effort ?? null,
          target: message.params.target
        };
        saveState(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
		        if (BEHAVIOR === "stalled-turn-start") {
		          // Never respond — simulates app-server alive but network stalled.
		          // companion's deadline must timeout and reject.
		          break;
		        }
	        if (BEHAVIOR === "turn-start-fails") {
	          throw new Error("turn/start failed after thread resolution");
	        }
	        if (BEHAVIOR === "reject-gpt-5.6" && String(message.params.model || "").startsWith("gpt-5.6-")) {
	          send({
	            id: message.id,
	            error: {
	              code: -32000,
	              message: "The '" + message.params.model + "' model requires a newer version of Codex."
	            }
	          });
	          break;
	        }
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
	        const turnId = nextTurnId(state);
	        thread.updatedAt = now();
	        thread.model = message.params.model ?? thread.model ?? null;
	        thread.reasoningEffort = message.params.effort ?? thread.reasoningEffort ?? null;
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && /^Codex (Companion Task|Task|Review|Rescue)/.test(thread.name) && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else if (BEHAVIOR === "spaced-events-idle-ok") {
	          // Long total turn duration (well past a fixed wall-clock budget),
	          // but each gap between events is short. Must NOT time out under an
	          // idle (inactivity) budget, only under a wall-clock one.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const gapMs = 700;
	          const stepCount = 6;
	          let step = 0;
	          const tick = () => {
	            step += 1;
	            send({
	              method: "item/started",
	              params: {
	                threadId: thread.id,
	                turnId,
	                item: { type: "commandExecution", id: "cmd_" + turnId + "_" + step, command: "step " + step, status: "inProgress" }
	              }
	            });
	            send({
	              method: "item/completed",
	              params: {
	                threadId: thread.id,
	                turnId,
	                item: { type: "commandExecution", id: "cmd_" + turnId + "_" + step, command: "step " + step, status: "completed" }
	              }
	            });
	            if (step >= stepCount) {
	              send({
	                method: "item/completed",
	                params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
	              });
	              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	              return;
	            }
	            setTimeout(tick, gapMs);
	          };
	          setTimeout(tick, gapMs);
	        } else if (BEHAVIOR === "goes-silent-after-first-event") {
	          // Emits one item/started and then never sends anything else for this
	          // turn. Must time out via the idle budget measured from that last
	          // event, not via a full-turn budget counted from turn/started.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "item/started",
	            params: {
	              threadId: thread.id,
	              turnId,
	              item: { type: "commandExecution", id: "cmd_" + turnId + "_1", command: "step 1", status: "inProgress" }
	            }
	          });
	          // Then silence — no further notifications for this turn, ever.
	        } else if (BEHAVIOR === "single-item-progress-idle-ok") {
	          // One item/started, then a long stream of commandExecution outputDelta
	          // notifications spanning well past the idle budget with no other
	          // item/started or item/completed in between, then item/completed.
	          // Must NOT time out — the deltas count as activity too.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "item/started",
	            params: {
	              threadId: thread.id,
	              turnId,
	              item: { type: "commandExecution", id: "cmd_" + turnId, command: "long-running step", status: "inProgress" }
	            }
	          });
	          const gapMs = 700;
	          const deltaCount = 6;
	          let step = 0;
	          const tick = () => {
	            step += 1;
	            send({
	              method: "item/commandExecution/outputDelta",
	              params: { threadId: thread.id, turnId, itemId: "cmd_" + turnId, delta: "chunk " + step + "\\n" }
	            });
	            if (step >= deltaCount) {
	              send({
	                method: "item/completed",
	                params: {
	                  threadId: thread.id,
	                  turnId,
	                  item: { type: "commandExecution", id: "cmd_" + turnId, command: "long-running step", status: "completed" }
	                }
	              });
	              send({
	                method: "item/completed",
	                params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
	              });
	              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	              return;
	            }
	            setTimeout(tick, gapMs);
	          };
	          setTimeout(tick, gapMs);
	        } else if (BEHAVIOR === "long-progress-hits-wall-clock-ceiling" || BEHAVIOR === "silent-turn-interrupt") {
	          // Continuously-progressing turn: one item/started, then a
	          // commandExecution outputDelta every 500ms for ~20s. Every delta
	          // resets the idle deadline, so the idle budget alone never fires --
	          // only the separate hard wall-clock ceiling can stop this turn.
	          // Registered as interruptible so turn/interrupt is observable. When
	          // BEHAVIOR is "silent-turn-interrupt" the turn/interrupt handler
	          // above never responds, exercising #47's turn/interrupt timeout.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "item/started",
	            params: {
	              threadId: thread.id,
	              turnId,
	              item: { type: "commandExecution", id: "cmd_" + turnId, command: "very long step", status: "inProgress" }
	            }
	          });
	          const ceilingGapMs = 500;
	          const ceilingDeltaCount = 40;
	          let ceilingStep = 0;
	          const ceilingTick = () => {
	            ceilingStep += 1;
	            send({
	              method: "item/commandExecution/outputDelta",
	              params: { threadId: thread.id, turnId, itemId: "cmd_" + turnId, delta: "chunk " + ceilingStep + "\\n" }
	            });
	            if (ceilingStep >= ceilingDeltaCount) {
	              send({
	                method: "item/completed",
	                params: {
	                  threadId: thread.id,
	                  turnId,
	                  item: { type: "commandExecution", id: "cmd_" + turnId, command: "very long step", status: "completed" }
	                }
	              });
	              send({
	                method: "item/completed",
	                params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
	              });
	              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	              interruptibleTurns.delete(turnId);
	              return;
	            }
	            const nextTimer = setTimeout(ceilingTick, ceilingGapMs);
	            interruptibleTurns.set(turnId, { threadId: thread.id, timer: nextTimer });
	          };
	          const firstCeilingTimer = setTimeout(ceilingTick, ceilingGapMs);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer: firstCeilingTimer });
	        } else if (BEHAVIOR === "reasoning-delta-idle-ok") {
	          // The gpt-5.6-sol/xhigh case #40 was filed for: a long reasoning
	          // stretch whose ONLY liveness signal is reasoning summary deltas.
	          // Those are opt-ed out at handshake by default, so before the fix
	          // the client never sees them and the idle budget kills the turn.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "item/started",
	            params: {
	              threadId: thread.id,
	              turnId,
	              item: { type: "reasoning", id: "rsn_" + turnId, status: "inProgress" }
	            }
	          });
	          const reasoningGapMs = 700;
	          const reasoningDeltaCount = 6;
	          let reasoningStep = 0;
	          const reasoningTick = () => {
	            reasoningStep += 1;
	            send({
	              method: "item/reasoning/summaryTextDelta",
	              params: {
	                threadId: thread.id,
	                turnId,
	                itemId: "rsn_" + turnId,
	                delta: "thinking " + reasoningStep + "\\n",
	                summaryIndex: 0
	              }
	            });
	            if (reasoningStep >= reasoningDeltaCount) {
	              send({
	                method: "item/completed",
	                params: { threadId: thread.id, turnId, item: { type: "reasoning", id: "rsn_" + turnId, status: "completed" } }
	              });
	              send({
	                method: "item/completed",
	                params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } }
	              });
	              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	              return;
	            }
	            setTimeout(reasoningTick, reasoningGapMs);
	          };
	          setTimeout(reasoningTick, reasoningGapMs);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        if (BEHAVIOR === "stalled-interrupt") {
	          // Never respond — simulates a wedged/hung broker or app-server during
	          // turn/interrupt. interruptAppServerTurn() must bound this request
	          // (DEFAULT_INTERRUPT_TIMEOUT_MS) instead of hanging forever, so a
	          // caller gating a state transition on the result (e.g. /codex:cancel
	          // finalizing an orphaned job) is never left stuck.
	          break;
	        }
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        // #47 finding 2 fixture: accept the connection and the request, but
	        // never respond, so callers verify turn/interrupt is bounded by its
	        // own timeout instead of hanging until the process is killed.
	        if (BEHAVIOR === "silent-turn-interrupt") {
	          break;
	        }
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

// One ephemeral CLAUDE_PLUGIN_DATA per worker process. Without this, buildEnv
// spreads ...process.env and inherits the real plugin data dir (or the
// $TMPDIR/codex-companion fallback), so tests write broker.json/state.json
// into the live plugin's data and leave them behind.
//
// We set process.env.CLAUDE_PLUGIN_DATA here (not just the returned env) so
// the worker process itself resolves state to the same root as the companion
// subprocesses it spawns. Tests like broker-lifecycle's "concurrent startup"
// spawn a child that calls ensureBrokerSession with buildEnv()'s env (root A),
// then call loadBrokerSession(repo) in-process — without this mutation that
// in-process read would resolve through the unset fallback (root B) and miss
// the broker.json the child wrote. Because the temp root lives under
// os.tmpdir(), state.test.mjs's startsWith(os.tmpdir()) assertion still holds.
let testPluginDataDir = null;
export function getTestPluginDataDir() {
  if (!testPluginDataDir) {
    testPluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-data-"));
    registerPluginDataDir(testPluginDataDir);
    process.env.CLAUDE_PLUGIN_DATA = testPluginDataDir;
  }
  return testPluginDataDir;
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    // Isolate plugin state from the host. Per-workspace state is still
    // namespaced under this root by resolveStateDir (sha256(realpath(cwd))),
    // so concurrent test workspaces do not collide.
    CLAUDE_PLUGIN_DATA: getTestPluginDataDir(),
    // Production keeps an idle broker warm for 15 minutes. Tests only need a
    // brief reuse window and should not leave dozens of detached helpers.
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "2000",
    // Production bounds a stuck turn/interrupt request at 15s. Tests exercising
    // a hung interrupt (BEHAVIOR "stalled-interrupt") should not wait that long.
    CODEX_INTERRUPT_TIMEOUT_MS: "1000"
  };
}
