import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  resolveCancelableJob,
  settleCancellationAfterTermination
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const FAKE_RESOLVED_SETTINGS = {
  model: "gpt-5.4",
  modelProvider: "openai",
  reasoningEffort: null,
  sandbox: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false
  }
};

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function readPersistedJob(workspaceRoot, jobId = null) {
  const stateDir = resolveStateDir(workspaceRoot);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const resolvedJobId = jobId ?? state.jobs[0].id;
  return JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${resolvedJobId}.json`), "utf8"));
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("review starts a persistent (non-ephemeral) thread so a rollout file is written", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].ephemeral, false);
});

test("adversarial review starts a persistent (non-ephemeral) thread so a rollout file is written", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].ephemeral, false);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task uses an explicit workspace cwd from an unrelated invocation directory", () => {
  const repo = makeTempDir();
  const invocationDir = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "-C", repo, "inspect the target workspace"], {
    cwd: invocationDir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  // Compare via realpath on both sides: on macOS /var is a symlink to
  // /private/var, and the companion canonicalizes the workspace path, so a
  // naive path.resolve() comparison diverges (/var/... vs /private/var/...).
  assert.equal(fs.realpathSync(fakeState.threads[0].cwd), fs.realpathSync(repo));
});

test("task rejects a nonexistent explicit workspace cwd", () => {
  const invocationDir = makeTempDir();
  const missingDir = path.join(invocationDir, "missing-workspace");
  const result = run("node", [SCRIPT, "task", "--cwd", missingDir, "inspect the target workspace"], {
    cwd: invocationDir
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task workspace directory does not exist/);
});

test("command help documents the task cwd option", () => {
  const result = run("node", [SCRIPT, "--help"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task \[--background\].*\[--cwd <dir>\]/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // [dim] no sandbox in the params: the host's ~/.codex/config.toml decides.
  assert.equal(fakeState.lastThreadResume.sandbox, null);
});

test("task --resume-last is not permanently blocked by a job stuck 'running' with a dead worker pid (upstream #392)", () => {
  // resolveLatestTrackedTaskThread() reads jobs via listJobs(), which already
  // reconciles a "running" job with a dead pid to "failed" (state.mjs's
  // reconcileRunningJobs, exercised directly by "status and resume candidates
  // mark a running job with a dead pid as failed" above). This test proves
  // that reconciliation actually unblocks the --resume-last gate itself, not
  // just /status and task-resume-candidate — the exact throw upstream #392
  // reports ("Task <id> is still running. Use /codex:status before continuing
  // it.") never fires for a worker that has actually exited.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-dead-worker" };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const job = state.jobs.find((entry) => entry.jobClass === "task");
  assert.ok(job, "expected the completed task job to be recorded");

  const exitedWorker = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exitedWorker.pid;
  const exitedForReal = new Promise((resolve, reject) => {
    exitedWorker.once("error", reject);
    exitedWorker.once("exit", resolve);
  });

  // Simulate the worker crashing mid-run: still "running", pid now dead, no
  // completedAt/result was ever written (the exact state a SIGKILL or an
  // uncaught exception leaves behind, since neither reaches runTrackedJob's
  // catch or a normal completion write).
  const stuckJob = { ...job, status: "running", phase: "running", pid: deadPid };
  const jobFile = path.join(stateDir, "jobs", `${job.id}.json`);
  writeJobFile(repo, job.id, { ...JSON.parse(fs.readFileSync(jobFile, "utf8")), status: "running", phase: "running", pid: deadPid });
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, jobs: [stuckJob] }, null, 2)}\n`, "utf8");

  return exitedForReal.then(() => {
    const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });

    assert.equal(resume.status, 0, resume.stderr);
    assert.doesNotMatch(resume.stderr, /is still running/i);
    assert.equal(resume.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    // [dim] no sandbox in the params: the host's ~/.codex/config.toml decides.
    assert.equal(fakeState.lastThreadResume.sandbox, null);
  });
});

test("task --resume-last is not permanently blocked by a job stuck 'queued' with a dead worker pid (upstream #425 gap)", () => {
  // reconcileRunningJobs (state.mjs) used to only reconcile job.status ===
  // "running". A detached worker that dies BEFORE runTrackedJob's first
  // write — the window between enqueueBackgroundTask recording
  // status:"queued" with the spawned child's pid, and that worker calling
  // runTrackedJob to flip it to "running" — was never reconciled: it stayed
  // "queued" forever, with a pid that's already dead, invisible to the
  // reconciliation check and permanently blocking --resume-last. This is the
  // detached-worker-dies-early half of what upstream #425's reapDeadJobs
  // (which reaps any queued/running job with a dead pid, not just running)
  // covers and #392's throw-site fix does not. Fixed by also reconciling
  // "queued" jobs, not just "running" ones.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-dead-queued-worker" };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const job = state.jobs.find((entry) => entry.jobClass === "task");
  assert.ok(job, "expected the completed task job to be recorded");

  const exitedWorker = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exitedWorker.pid;
  const exitedForReal = new Promise((resolve, reject) => {
    exitedWorker.once("error", reject);
    exitedWorker.once("exit", resolve);
  });

  const stuckJob = { ...job, status: "queued", phase: "queued", pid: deadPid };
  const jobFile = path.join(stateDir, "jobs", `${job.id}.json`);
  writeJobFile(repo, job.id, { ...JSON.parse(fs.readFileSync(jobFile, "utf8")), status: "queued", phase: "queued", pid: deadPid });
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, jobs: [stuckJob] }, null, 2)}\n`, "utf8");

  return exitedForReal.then(() => {
    const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });

    assert.equal(resume.status, 0, resume.stderr);
    assert.doesNotMatch(resume.stderr, /is still running/i);
  });
});

test("task-resume-candidate uses an explicit workspace cwd from an unrelated invocation directory", () => {
  const workspace = makeTempDir();
  const invocationDir = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "-C", workspace, "--json"], {
    cwd: invocationDir,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task-resume-candidate rejects a nonexistent explicit workspace cwd", () => {
  const invocationDir = makeTempDir();
  const missingDir = path.join(invocationDir, "missing-workspace");
  const result = run("node", [SCRIPT, "task-resume-candidate", "--cwd", missingDir, "--json"], {
    cwd: invocationDir
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task workspace directory does not exist/);
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "workspace-write");
});

test("task --write starts Codex with workspace-write sandbox", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--write", "capture the page"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadStart.sandbox, "workspace-write");
});

test("resuming task --write upgrades the thread to workspace-write sandbox", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--write", "--resume-last", "capture the page"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadResume.sandbox, "workspace-write");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run(
    "node",
    [SCRIPT, "task", "--resume", "--model", "gpt-5.6-terra", "--effort", "max", "follow up"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastThreadResume.model, "gpt-5.6-terra");
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-terra");
  assert.equal(fakeState.lastTurnStart.effort, "max");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("resume validates the persisted thread provider even when current config uses a custom provider", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "custom-provider");
  initGitRepo(repo);

  const first = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);
  const initialTurnId = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.turnId;

  const resumed = run(
    "node",
    [SCRIPT, "task", "--resume", "--model", "gpt-5.6-luna", "--effort", "ultra", "follow up"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.turnId, initialTurnId);
});

test("resume validates effort against the persisted thread model instead of current config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "config-luna");
  initGitRepo(repo);

  const first = run(
    "node",
    [SCRIPT, "task", "--model", "gpt-5.6-sol", "--effort", "high", "initial task"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume", "--effort", "ultra", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadResume.model, "gpt-5.6-sol");
  assert.equal(state.lastTurnStart.model, null);
  assert.equal(state.lastTurnStart.effort, "ultra");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "resolved-effort");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // [dim] no sandbox in the params: the host's ~/.codex/config.toml decides.
  assert.equal(fakeState.lastThreadStart.sandbox, null);
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
  assert.deepEqual(readPersistedJob(repo).resolved, {
    ...FAKE_RESOLVED_SETTINGS,
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "low"
  });
});

test("task preserves resolved settings when turn/start fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--effort", "xhigh", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /turn\/start failed after thread resolution/);
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed");
  assert.deepEqual(storedJob.resolved, FAKE_RESOLVED_SETTINGS);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs[0].resolved, FAKE_RESOLVED_SETTINGS);
});

test("task supports max and ultra while rejecting unsupported model combinations locally", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const max = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "max", "check"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(max.status, 0, max.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.effort, "max");

  const ultra = run("node", [SCRIPT, "task", "--model", "gpt-5.6-sol", "--effort", "ultra", "check"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(ultra.status, 0, ultra.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.effort, "ultra");

  const invalid = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "ultra", "check"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastThreadStart.model, "gpt-5.6-sol");
});

test("task validates model and effort inherited from Codex config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "inherited-sol-max");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "check inherited selection"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadStart.model, "gpt-5.6-sol");
  assert.equal(state.lastThreadStart.effort, "max");
  assert.equal(state.lastTurnStart.model, null);
  assert.equal(state.lastTurnStart.effort, null);
});

test("task rejects an unsupported model and effort inherited from Codex config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "inherited-luna-ultra");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "check inherited selection"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reasoning effort "ultra" is not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).threads.length, 0);
});

test("task prevalidates a partial explicit selection against Codex config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "inherited-luna-ultra");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--effort", "ultra", "check selection"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).threads.length, 0);
});

test("task prevalidates effort against the catalog default before creating a persistent thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "inherited-default-luna-ultra");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--effort", "ultra", "check default selection"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).threads.length, 0);
});

test("task falls back cleanly when an older Codex CLI does not expose model/list", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-list-unsupported");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-sol", "--effort", "max", "check"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
});

test("task does not apply the OpenAI effort matrix to a custom provider", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "custom-provider");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "ultra", "check"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
});

test("review rejects an unsupported explicit selection before creating a thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const result = run("node", [SCRIPT, "review", "--model", "gpt-5.6-luna", "--effort", "ultra"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not supported by model "gpt-5\.6-luna"/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).threads.length, 0);
});

test("review and adversarial-review consume model and effort flags instead of leaking them into focus text", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const review = run("node", [SCRIPT, "review", "--model", "gpt-5.6-sol", "--effort", "max"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);
  let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadStart.model, "gpt-5.6-sol");
  assert.equal(state.lastThreadStart.effort, "max");

  const adversarial = run(
    "node",
    [SCRIPT, "adversarial-review", "--model", "gpt-5.6-terra", "--effort", "xhigh", "challenge retries"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(adversarial.status, 0, adversarial.stderr);
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.6-terra");
  assert.equal(state.lastTurnStart.effort, "xhigh");
  assert.doesNotMatch(state.lastTurnStart.prompt, /--model|--effort/);
  assert.match(state.lastTurnStart.prompt, /challenge retries/);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background preserves --read-only through the detached worker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--read-only", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const runningJob = await waitFor(() => {
    try {
      const storedJob = readPersistedJob(repo, launchPayload.jobId);
      return storedJob.status === "running" && storedJob.resolved ? storedJob : null;
    } catch {
      return null;
    }
  });
  assert.deepEqual(runningJob.resolved, FAKE_RESOLVED_SETTINGS);
  const runningState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.deepEqual(runningState.jobs.find((job) => job.id === launchPayload.jobId).resolved, FAKE_RESOLVED_SETTINGS);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.deepEqual(resultPayload.job.resolved, FAKE_RESOLVED_SETTINGS);
  assert.deepEqual(resultPayload.storedJob.resolved, FAKE_RESOLVED_SETTINGS);
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("task --read-only pins the app-server thread sandbox", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--read-only", "inspect the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("task --read-only pins resumed app-server threads", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--read-only", "--resume-last", "read-only follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.sandbox, "read-only");
});

test("task --read-only fails closed if the app-server resumes a write-capable sandbox", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "resume-ignores-sandbox");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--read-only", "--resume-last", "read-only follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "must fail closed when resolved sandbox is not read-only");
  assert.match(result.stderr, /read-only/i);
});

test("task rejects --write with --read-only", () => {
  const result = run("node", [SCRIPT, "task", "--write", "--read-only", "inspect the failing test"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --write or --read-only\./);
});

test("review accepts (ignores) positional focus text for parity with adversarial-review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // Parity with /codex:adversarial-review: positional args no longer abort the
  // native review. The native reviewer (review/start) does not consume focus
  // text, so leftover words are ignored rather than rejecting the invocation.
  // This keeps `/codex:review --model sol` usable when a host (e.g. Claude)
  // forwards residual positional text alongside flags.
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /does not support custom focus text/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // Bare `status` filters to the current Claude session, so pin the session id on
  // both the fixture jobs and the child env — otherwise the host's exported
  // CODEX_COMPANION_SESSION_ID leaks in and filters these jobs away.
  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // See the note on the `status shows phases` test: bare `status` is
  // session-filtered, so the session id is pinned on both sides.
  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("status and resume candidates mark a running job with a dead pid as failed", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const exitedWorker = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exitedWorker.pid;
  await new Promise((resolve, reject) => {
    exitedWorker.once("error", reject);
    exitedWorker.once("exit", resolve);
  });

  const jobId = "task-stale";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const staleJob = {
    id: jobId,
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-stale",
    threadId: "thr_stale",
    summary: "Investigate flaky test",
    pid: deadPid,
    logFile,
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    updatedAt: "2026-03-18T15:30:02.000Z"
  };
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(jobFile, `${JSON.stringify(staleJob, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [staleJob] }, null, 2)}\n`,
    "utf8"
  );

  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-stale" };
  const candidateResult = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env });
  assert.equal(candidateResult.status, 0, candidateResult.stderr);
  const candidate = JSON.parse(candidateResult.stdout);
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.status, "failed");

  const statusResult = run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout);
  assert.deepEqual(status.running, []);
  assert.equal(status.latestFinished.status, "failed");
  assert.equal(status.latestFinished.errorMessage, "Process exited without reporting.");

  const persistedState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(persistedState.jobs[0].status, "failed");
  assert.equal(persistedState.jobs[0].pid, null);
  const persistedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(persistedJob.status, "failed");
  assert.equal(persistedJob.errorMessage, "Process exited without reporting.");
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // `result` with no job id filters to the current Claude session
  // (filterJobsForCurrentSession in job-control.mjs). That filter is a no-op only
  // when CODEX_COMPANION_SESSION_ID is unset, so a bare run() inherits whatever
  // the host session exports and drops this fixture job — green in CI, red inside
  // a Claude Code session. Pin both sides instead of relying on the ambient value.
  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

function writeOrphanedJobFixture(workspace, { threadId = "thr_orphaned", turnId = "turn_orphaned" } = {}) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-orphaned.log");
  const jobFile = path.join(jobsDir, "task-orphaned.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-orphaned",
        status: "running",
        title: "Codex Task",
        threadId,
        turnId,
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-orphaned",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            threadId,
            turnId,
            // A pid that is guaranteed to be dead simulates the SIGKILLed foreground process.
            pid: 999999,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return { stateDir, jobsDir, logFile, jobFile };
}

test("cancel reaches a job orphaned by a SIGKILLed companion process once the remote turn interrupt succeeds (closes #42)", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // buildEnv() pins process.env.CLAUDE_PLUGIN_DATA for this worker (see its doc
  // comment) — resolve it before writeOrphanedJobFixture computes resolveStateDir,
  // so the in-process read and the spawned companion's state dir agree.
  const env = buildEnv(binDir);
  const { stateDir, logFile, jobFile } = writeOrphanedJobFixture(workspace);

  // Reconciliation (triggered by /codex:status) flips the dead-pid job to "failed"
  // before cancel ever runs, mirroring the real orphan sequence from the issue.
  const statusResult = run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const reconciled = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs.find(
    (job) => job.id === "task-orphaned"
  );
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.errorMessage, "Process exited without reporting.");

  const cancelResult = run("node", [SCRIPT, "cancel", "task-orphaned", "--json"], {
    cwd: workspace,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const payload = JSON.parse(cancelResult.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterrupted, true);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-orphaned");
  assert.equal(cancelled.status, "cancelled");

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel does not finalize an orphaned job as cancelled when the remote turn interrupt fails, and stays retryable", () => {
  const workspace = makeTempDir();
  const { stateDir, logFile, jobFile } = writeOrphanedJobFixture(workspace);

  // No fake codex on PATH: interruptAppServerTurn cannot reach a real broker/thread,
  // so the interrupt attempt fails (or is never attempted) — this must NOT be
  // treated as a successful cancellation, since nothing actually stopped the
  // orphaned remote turn.
  const statusResult = run("node", [SCRIPT, "status", "--json"], { cwd: workspace });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const reconciled = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs.find(
    (job) => job.id === "task-orphaned"
  );
  assert.equal(reconciled.status, "failed");

  const cancelResult = run("node", [SCRIPT, "cancel", "task-orphaned", "--json"], {
    cwd: workspace
  });

  assert.notEqual(cancelResult.status, 0);
  assert.match(cancelResult.stderr, /remote Codex turn interrupt failed/i);

  // The job must remain in its original orphaned-failed state so a retried
  // /codex:cancel can still select and re-attempt it via isOrphanedTurn.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const stillOrphaned = state.jobs.find((job) => job.id === "task-orphaned");
  assert.equal(stillOrphaned.status, "failed");
  assert.equal(stillOrphaned.errorMessage, "Process exited without reporting.");
  assert.equal(stillOrphaned.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.errorMessage, "Process exited without reporting.");

  const retryResult = run("node", [SCRIPT, "cancel", "task-orphaned", "--json"], {
    cwd: workspace
  });
  assert.notEqual(retryResult.status, 0);
  assert.match(retryResult.stderr, /remote Codex turn interrupt failed/i);
});

test("cancel on an orphaned job does not persist cancelled while the remote interrupt is still hung, and stays retryable once it times out", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "stalled-interrupt");
  const env = buildEnv(binDir);
  const { stateDir, logFile, jobFile } = writeOrphanedJobFixture(workspace);

  const statusResult = run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env });
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const reconciled = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs.find(
    (job) => job.id === "task-orphaned"
  );
  assert.equal(reconciled.status, "failed");

  // The fake broker never answers turn/interrupt. Without a bounded timeout on
  // that request, /codex:cancel would hang here; with one, it must return
  // (non-zero) once the timeout fires rather than persisting "cancelled" before
  // the interrupt is confirmed.
  const cancelResult = run("node", [SCRIPT, "cancel", "task-orphaned", "--json"], {
    cwd: workspace,
    env
  });

  assert.notEqual(cancelResult.status, 0);
  assert.match(cancelResult.stderr, /remote Codex turn interrupt failed/i);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const stillOrphaned = state.jobs.find((job) => job.id === "task-orphaned");
  assert.equal(stillOrphaned.status, "failed");
  assert.equal(stillOrphaned.errorMessage, "Process exited without reporting.");

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "failed");
  assert.match(fs.readFileSync(logFile, "utf8"), /remote Codex turn interrupt failed/i);
});

test("failed cancellation restores a live job so cancellation can be retried", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-cancel-failed-live",
    status: "running",
    phase: "investigating",
    title: "Codex Task",
    jobClass: "task",
    pid: process.pid
  };
  const existing = {
    ...job,
    request: {
      cwd: workspace,
      prompt: "Investigate the flaky test"
    }
  };
  const completedAt = "2026-03-18T15:31:00.000Z";

  writeJobFile(workspace, job.id, {
    ...existing,
    status: "cancelled",
    phase: "cancelled",
    completedAt,
    cancelledAt: completedAt,
    errorMessage: "Cancelled by user."
  });
  upsertJob(workspace, {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt,
    errorMessage: "Cancelled by user."
  });

  const terminationError = new Error("Access is denied.");
  const outcome = settleCancellationAfterTermination(
    workspace,
    job,
    existing,
    null,
    terminationError,
    { isProcessAliveImpl: () => true }
  );

  assert.equal(outcome.processStopped, false);
  assert.equal(outcome.error, terminationError);
  assert.equal(outcome.job.status, "running");
  assert.equal(outcome.job.pid, process.pid);
  assert.match(outcome.job.errorMessage, /retry \/codex:cancel/i);

  const retryable = resolveCancelableJob(workspace, job.id);
  assert.equal(retryable.job.status, "running");
  assert.equal(retryable.job.pid, process.pid);

  const stored = JSON.parse(
    fs.readFileSync(path.join(resolveStateDir(workspace), "jobs", `${job.id}.json`), "utf8")
  );
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "investigating");
  assert.equal(stored.pid, process.pid);
  assert.equal("completedAt" in stored, false);
  assert.equal("cancelledAt" in stored, false);
  assert.match(stored.errorMessage, /retry \/codex:cancel/i);
});

test("failed cancellation remains cancelled when the process is already dead", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-cancel-failed-dead",
    status: "running",
    phase: "investigating",
    title: "Codex Task",
    jobClass: "task",
    pid: 999999
  };
  const existing = { ...job };
  const completedAt = "2026-03-18T15:31:00.000Z";
  const cancelledJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspace, job.id, {
    ...cancelledJob,
    cancelledAt: completedAt
  });
  upsertJob(workspace, cancelledJob);

  const outcome = settleCancellationAfterTermination(
    workspace,
    job,
    existing,
    { attempted: true, delivered: false, method: "taskkill" },
    null,
    { isProcessAliveImpl: () => false }
  );

  assert.equal(outcome.processStopped, true);
  assert.equal(outcome.error, null);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "jobs", `${job.id}.json`), "utf8")).status,
    "cancelled"
  );
});

test("cancelled queued jobs remain stored and are skipped by a late worker", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-queued";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const queuedJob = {
    id: jobId,
    status: "queued",
    phase: "queued",
    title: "Codex Task",
    jobClass: "task",
    summary: "Investigate flaky test",
    pid: null,
    logFile,
    request: {
      cwd: workspace,
      model: null,
      effort: null,
      prompt: "Investigate the flaky test",
      write: false,
      resumeLast: false,
      jobId
    },
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:30:00.000Z"
  };
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Queued for background execution.\n", "utf8");
  fs.writeFileSync(jobFile, `${JSON.stringify(queuedJob, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [queuedJob] }, null, 2)}\n`,
    "utf8"
  );

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: workspace });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");
  assert.equal(fs.existsSync(jobFile), true);

  const worker = run("node", [SCRIPT, "task-worker", "--cwd", workspace, "--job-id", jobId], {
    cwd: workspace
  });
  assert.equal(worker.status, 0, worker.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
});

test("tracked jobs preserve cancellation observed during execution", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-race";
  const stateDir = resolveStateDir(workspace);
  const logFile = path.join(stateDir, "jobs", `${jobId}.log`);
  const job = {
    id: jobId,
    status: "queued",
    title: "Codex Task",
    workspaceRoot: workspace,
    jobClass: "task",
    summary: "Investigate flaky test",
    logFile
  };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "", "utf8");
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const execution = await runTrackedJob(
    job,
    async () => {
      const cancelledAt = new Date().toISOString();
      const runningJob = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
      writeJobFile(workspace, jobId, {
        ...runningJob,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: cancelledAt,
        errorMessage: "Cancelled by user."
      });
      upsertJob(workspace, {
        id: jobId,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: cancelledAt,
        errorMessage: "Cancelled by user."
      });
      return {
        exitStatus: 0,
        threadId: "thr_cancelled",
        turnId: "turn_cancelled",
        payload: { status: 0 },
        rendered: "should not replace cancellation",
        summary: "Should not replace cancellation"
      };
    },
    { logFile }
  );

  assert.equal(execution.payload.status, "cancelled");
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8")).status, "cancelled");
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  installFakeCodex(binDir, "interruptible-slow-task", "codex-cli 0.144.0");

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end keeps finished results and marks interrupted jobs failed", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);

  // A finished run is the whole point of having delegated to Codex: its result
  // file and log must survive the session that ordered it, so the next session
  // can still fetch it by id via `result`.
  assert.equal(fs.existsSync(completedJobFile), true);
  assert.equal(fs.existsSync(completedLog), true);
  assert.equal(fs.existsSync(runningLog), true);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(
    state.jobs.map((job) => job.id).sort(),
    ["review-completed", "review-other", "review-running"]
  );

  const completedJob = state.jobs.find((job) => job.id === "review-completed");
  assert.equal(completedJob.status, "completed");
  assert.equal(completedJob.logFile, completedLog);

  // The interrupted run is stopped, but it is recorded as failed with a reason
  // instead of vanishing — silence is what makes a lost run indistinguishable
  // from an empty answer.
  const interruptedJob = state.jobs.find((job) => job.id === "review-running");
  assert.equal(interruptedJob.status, "failed");
  assert.equal(interruptedJob.phase, "failed");
  assert.equal(interruptedJob.pid, null);
  assert.match(interruptedJob.errorMessage ?? "", /session ended/i);
  assert.ok(interruptedJob.completedAt);

  const storedInterrupted = JSON.parse(fs.readFileSync(runningJobFile, "utf8"));
  assert.equal(storedInterrupted.status, "failed");
  assert.match(storedInterrupted.errorMessage ?? "", /session ended/i);

  const otherJob = state.jobs.find((job) => job.id === "review-other");
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("session start reaps workers and broker files their session left behind", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const strandedLog = path.join(jobsDir, "stranded.log");
  const strandedJobFile = path.join(jobsDir, "task-stranded.json");
  fs.writeFileSync(strandedLog, "stranded\n", "utf8");
  fs.writeFileSync(strandedJobFile, JSON.stringify({ id: "task-stranded" }, null, 2), "utf8");

  // A worker whose process is already gone: the previous session was closed
  // through the desktop window, which never delivers SessionEnd, so nothing
  // ever flipped this record off "running".
  const corpse = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  corpse.unref();
  const deadPid = corpse.pid;
  await waitFor(() => {
    try {
      process.kill(deadPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const brokerSessionDir = makeTempDir();
  const brokerPidFile = path.join(brokerSessionDir, "broker.pid");
  const brokerLogFile = path.join(brokerSessionDir, "broker.log");
  fs.writeFileSync(brokerPidFile, `${deadPid}\n`, "utf8");
  fs.writeFileSync(brokerLogFile, "broker\n", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "broker.json"),
    `${JSON.stringify(
      {
        endpoint: "pipe:\\.\pipe\cxc-dead-codex-app-server",
        pidFile: brokerPidFile,
        logFile: brokerLogFile,
        sessionDir: brokerSessionDir,
        pid: deadPid
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-stranded",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-previous",
            pid: deadPid,
            logFile: strandedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-new" },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-new",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The record must stop claiming to be running: a job frozen at "running"
  // with a dead pid blocks --resume-last and reads as work still in flight.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const stranded = state.jobs.find((job) => job.id === "task-stranded");
  assert.equal(stranded.status, "failed");
  assert.equal(stranded.pid, null);
  assert.ok(stranded.errorMessage);

  // Reaping is bookkeeping, not deletion — the log and result file stay.
  assert.equal(fs.existsSync(strandedLog), true);
  assert.equal(fs.existsSync(strandedJobFile), true);
  const storedStranded = JSON.parse(fs.readFileSync(strandedJobFile, "utf8"));
  assert.equal(storedStranded.status, "failed");

  // The broker records point at a process that no longer exists; leaving them
  // behind strands the pid and log files for good once the workspace goes idle.
  assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), false);
  assert.equal(fs.existsSync(brokerPidFile), false);
  assert.equal(fs.existsSync(brokerLogFile), false);
});

test("session start leaves a live worker and a live broker untouched", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  // Two sessions can share one workspace: a second window opening must never
  // reap the first one's in-flight run or the broker they share.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const brokerSessionDir = makeTempDir();
  const brokerPidFile = path.join(brokerSessionDir, "broker.pid");
  fs.writeFileSync(brokerPidFile, `${sleeper.pid}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "broker.json"),
    `${JSON.stringify(
      {
        endpoint: "pipe:\\.\pipe\cxc-live-codex-app-server",
        pidFile: brokerPidFile,
        logFile: null,
        sessionDir: brokerSessionDir,
        pid: sleeper.pid
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other-window",
            pid: sleeper.pid,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-new" },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-new",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const live = state.jobs.find((job) => job.id === "task-live");
  assert.equal(live.status, "running");
  assert.equal(live.pid, sleeper.pid);

  assert.equal(fs.existsSync(path.join(stateDir, "broker.json")), true);
  assert.equal(fs.existsSync(brokerPidFile), true);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("shared broker invalidates stale CLI, plugin, and legacy runtime state", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "reject-gpt-5.6", "codex-cli 0.143.0");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  const env = buildEnv(binDir);

  const first = run("node", [SCRIPT, "task", "first"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(loadBrokerSession(repo), "expected the first task to create a shared broker");

  installFakeCodex(binDir, "review-ok", "codex-cli 0.144.0");
  const second = run(
    "node",
    [SCRIPT, "task", "--model", "gpt-5.6-sol", "--effort", "high", "second"],
    { cwd: repo, env }
  );
  assert.equal(second.status, 0, second.stderr);

  let state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(state.appServerStarts, 2);
  assert.equal(loadBrokerSession(repo).runtime.codexVersion, "codex-cli 0.144.0");

  let broker = loadBrokerSession(repo);
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "broker.json"),
    `${JSON.stringify({ ...broker, runtime: { ...broker.runtime, pluginVersion: "1.0.6" } }, null, 2)}\n`
  );
  const pluginUpgrade = run("node", [SCRIPT, "task", "after plugin upgrade"], { cwd: repo, env });
  assert.equal(pluginUpgrade.status, 0, pluginUpgrade.stderr);
  state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(state.appServerStarts, 3);

  broker = loadBrokerSession(repo);
  const { runtime: _runtime, ...legacyBroker } = broker;
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "broker.json"),
    `${JSON.stringify(legacyBroker, null, 2)}\n`
  );
  const legacyUpgrade = run("node", [SCRIPT, "task", "after legacy upgrade"], { cwd: repo, env });
  assert.equal(legacyUpgrade.status, 0, legacyUpgrade.stderr);
  state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(state.appServerStarts, 4);

  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(targetWorkspace);

  const task = run("node", [SCRIPT, "task", "start shared runtime"], {
    cwd: targetWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(task.status, 0, task.stderr);
  const broker = loadBrokerSession(targetWorkspace);
  if (!broker) {
    return;
  }

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, broker.endpoint);

  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: targetWorkspace,
    env: buildEnv(binDir),
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: targetWorkspace })
  });
});

test("task with stalled turn/start times out via --turn-timeout-ms instead of hanging forever", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "stalled-turn-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // 3s timeout — must reject within that, not hang forever.
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "3000", "test prompt"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // Must NOT hang — exit with a timeout error.
  assert.notEqual(result.status, 0, "must exit non-zero on timeout, not hang");
  assert.match(result.stderr, /turn budget/i, "error must mention the turn budget");
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed", "job must be marked failed");
});

test("task with spaced-out events longer than the budget does NOT time out (idle, not wall-clock)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "spaced-events-idle-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Fixture emits 6 events spaced 700ms apart (~4.2s total) — longer than this
  // 2s budget, but every individual gap is well under it. Under an idle
  // (inactivity) timeout this must succeed; under the old wall-clock design
  // it would fail once the 4.2s of total turn time exceeded the 2s budget.
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, `must succeed despite total turn time exceeding the budget: ${result.stderr}`);
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "completed", "job must complete, not be killed mid-flight");
});

test("task that goes silent after the first event times out via the idle budget, measured from the last event", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "goes-silent-after-first-event");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const start = Date.now();
  // Fixture sends turn/started + one item/started, then never speaks again.
  // A 3s idle budget must fire ~3s after that last event, not hang toward a
  // full-turn budget counted from turn start (there is none here to expire
  // against under the old design other than the same 3s, but the assertion
  // below pins the behavior explicitly: bounded and fast).
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "3000", "test prompt"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(result.status, 0, "must exit non-zero once idle for longer than the budget");
  assert.match(result.stderr, /turn budget/i, "error must mention the turn budget");
  assert.ok(elapsedMs < 15000, `must time out close to the idle budget, not hang (took ${elapsedMs}ms)`);
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed", "job must be marked failed");
});

test("task with in-item output-delta progress longer than the budget does NOT time out (single long item, idle not wall-clock)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "single-item-progress-idle-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Fixture emits one item/started, then 6 item/commandExecution/outputDelta
  // notifications spaced 700ms apart (~4.2s total) with no other item/started
  // or item/completed in between, then completes. The gap between the initial
  // item/started and the first delta (and each subsequent delta) is well
  // under the 2s budget, but the total span from item/started to the final
  // item/completed exceeds it. Must NOT time out: in-item progress deltas
  // must reset the idle deadline just like item boundaries do.
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, `must succeed despite one long item spanning the budget: ${result.stderr}`);
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "completed", "job must complete, not be killed mid-item");
});

test("a continuously-progressing turn is still bounded by the hard wall-clock ceiling, and the turn is interrupted", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "long-progress-hits-wall-clock-ceiling");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // The fixture streams an outputDelta every 500ms for ~20s, so the 2s idle
  // budget is reset continuously and never fires. Only the hard wall-clock
  // ceiling can stop this turn. Before the fix that ceiling was the fixed
  // 45-minute HARD_WALL_CLOCK_CEILING_MS constant, so the turn ran to
  // completion (~20s) and this test failed on both the status and the elapsed
  // assertions. With the ceiling configurable, 3500ms must cut it.
  const start = Date.now();
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_TURN_HARD_CEILING_MS: "3500" }
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(result.status, 0, "must fail via the wall-clock ceiling, not complete");
  assert.match(
    result.stderr,
    /hard wall-clock ceiling/i,
    `must report the ceiling, not the idle budget: ${result.stderr}`
  );
  assert.ok(
    elapsedMs < 15000,
    `must be cut at the ~3.5s ceiling, not run the fixture's full ~20s (took ${elapsedMs}ms)`
  );
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed", "job must be marked failed");

  // The catch block must reach interruptAppServerTurn so the broker stops
  // executing a turn we have already reported as failed.
  const fixtureState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fixtureState.lastInterrupt, "the timed-out turn must be interrupted on the app-server");
});

test("a foreground turn's wall-clock ceiling stays below the host's Bash SIGKILL", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "long-progress-hits-wall-clock-ceiling");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Same continuously-progressing fixture, driven through the FOREGROUND path
  // (no --background). Before the fix the ceiling was the fixed 45-minute
  // constant, so a foreground turn that keeps producing events could outlive
  // Claude Code's ~120s Bash SIGKILL — killed before captureTurn's catch could
  // send turn/interrupt, orphaning a live turn on the broker. Asserting the
  // resolved number directly would mean leaking it into user-facing output, so
  // this drives the observable behaviour instead: with the ceiling lowered to
  // 2500ms via the env override, a foreground run must be cut by the ceiling
  // (not by the 2s idle budget, which the deltas keep resetting) and must
  // interrupt the turn. That only holds if the foreground path honours a
  // configurable ceiling at all.
  const start = Date.now();
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_TURN_HARD_CEILING_MS: "2500" }
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(result.status, 0, "foreground turn must be cut by its ceiling");
  assert.match(result.stderr, /hard wall-clock ceiling/i, `must cite the ceiling: ${result.stderr}`);
  assert.ok(elapsedMs < 15000, `must be cut at the ceiling, not run ~20s (took ${elapsedMs}ms)`);
  const fixtureState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fixtureState.lastInterrupt, "foreground timeout must still interrupt the turn");
});

test("turn/interrupt itself is bounded: a broker that accepts it but never answers does not hang the companion (#47)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "silent-turn-interrupt");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Same continuously-progressing fixture as the wall-clock-ceiling tests, but
  // the fixture's turn/interrupt handler accepts the request and never
  // responds. Before the #47 fix, client.request("turn/interrupt", ...) had
  // no timeoutMs, so captureTurn's catch would block on it indefinitely --
  // bounded in practice only by the host's own SIGKILL. Assert the process
  // still exits promptly: ceiling (2500ms) + interrupt timeout (5000ms) with
  // generous headroom, well under the fixture's ~20s full run and far below
  // a host kill.
  const start = Date.now();
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_TURN_HARD_CEILING_MS: "2500" }
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(result.status, 0, "must fail via the wall-clock ceiling, not complete");
  assert.ok(
    elapsedMs < 15000,
    `must exit within ceiling + interrupt timeout, not hang on the unanswered turn/interrupt (took ${elapsedMs}ms)`
  );
  const fixtureState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fixtureState.lastInterrupt, "turn/interrupt must still have been attempted");
});

test("a long reasoning stretch keeps the turn alive: reasoning deltas are not opted out at handshake", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "reasoning-delta-idle-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // This is the exact gpt-5.6-sol/effort=xhigh case #40 was filed for: a long
  // reasoning stretch whose ONLY liveness signal is reasoning summary deltas.
  // Those were listed in DEFAULT_CAPABILITIES.optOutNotificationMethods, so
  // the server never sent them, applyTurnNotification never reset the idle
  // deadline, and the turn was killed mid-reasoning despite being alive.
  const result = run("node", [SCRIPT, "task", "--turn-timeout-ms", "2000", "test prompt"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(
    result.status,
    0,
    `a reasoning stretch spanning the idle budget must not time out: ${result.stderr}`
  );
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "completed", "job must complete, not be killed mid-reasoning");

  // Assert the cause directly, not just the symptom: the handshake must no
  // longer opt out of the three delta methods that carry liveness.
  const fixtureState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const optedOut = fixtureState.capabilities?.optOutNotificationMethods ?? [];
  for (const method of ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta"]) {
    assert.ok(!optedOut.includes(method), `${method} must not be opted out — it is a liveness signal`);
  }
  // The boundary marker stays opted out: it is not a reset source.
  assert.ok(
    optedOut.includes("item/reasoning/summaryPartAdded"),
    "item/reasoning/summaryPartAdded must stay opted out (boundary marker, not a delta)"
  );
});

test("adversarial review with stalled turn/start times out via --turn-timeout-ms instead of hanging on the 600s default", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "stalled-turn-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const start = Date.now();
  // adversarial-review routes through runAppServerTurn (unlike native `review`,
  // which uses runAppServerReview). turnTimeoutMs must reach that call too —
  // without it, this hangs toward the library's 600000ms default instead of
  // the 3s budget requested here.
  const result = run("node", [SCRIPT, "adversarial-review", "--turn-timeout-ms", "3000"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(result.status, 0, "must exit non-zero on timeout, not hang");
  assert.match(result.stderr, /turn budget/i, "error must mention the turn budget");
  assert.ok(elapsedMs < 15000, `must time out close to the requested budget, not the 600s default (took ${elapsedMs}ms)`);
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed", "job must be marked failed");
});
