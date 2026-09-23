import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, scaleTimeout } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

function promptPath(args, options) {
  return run("node", [SCRIPT, "prompt-path", ...args], options);
}

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

test("prompt-path prints an absolute path inside the state dir's prompts directory, without creating the file", () => {
  const workspace = makeTempDir();

  const result = promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env });

  assert.equal(result.status, 0, result.stderr);
  const printedPath = result.stdout.trim();
  assert.equal(path.isAbsolute(printedPath), true);

  const expectedDir = path.join(resolveStateDir(workspace), "prompts");
  assert.equal(path.dirname(printedPath), expectedDir);
  assert.match(path.basename(printedPath), /^rescue-[a-z0-9]+-[a-z0-9]{6}\.md$/);

  // The directory is created so a subsequent Write can succeed, but the file
  // itself must not exist yet: Claude Code's Write tool refuses to overwrite
  // a path it has not read, so a pre-created (even empty) file would make the
  // very next step fail.
  assert.equal(fs.existsSync(expectedDir), true);
  assert.equal(fs.existsSync(printedPath), false);
});

test("prompt-path defaults the label to 'task' when none is given", () => {
  const workspace = makeTempDir();

  const result = promptPath(["--cwd", workspace], { cwd: workspace, env: process.env });

  assert.equal(result.status, 0, result.stderr);
  const printedPath = result.stdout.trim();
  assert.match(path.basename(printedPath), /^task-[a-z0-9]+-[a-z0-9]{6}\.md$/);
});

test("two prompt-path calls in a row yield two different, not-yet-existing paths", () => {
  const workspace = makeTempDir();

  const first = promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env }).stdout.trim();
  const second = promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env }).stdout.trim();

  assert.notEqual(first, second);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test("prompt-path --json reports the same path as the plain-text form", () => {
  const workspace = makeTempDir();

  const result = promptPath(["--cwd", workspace, "--label", "rescue", "--json"], { cwd: workspace, env: process.env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(path.isAbsolute(payload.path), true);
  assert.equal(path.dirname(payload.path), path.join(resolveStateDir(workspace), "prompts"));
});

test("prompt-path rejects a nonexistent explicit workspace cwd", () => {
  const invocationDir = makeTempDir();
  const missingDir = path.join(invocationDir, "missing-workspace");

  const result = promptPath(["--cwd", missingDir], { cwd: invocationDir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task workspace directory does not exist/);
});

test("prompt-path sweeps prompt files older than 7 days but keeps fresh ones", () => {
  const workspace = makeTempDir();
  const promptsDir = path.join(resolveStateDir(workspace), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  const oldFile = path.join(promptsDir, "rescue-old-aaaaaa.md");
  const freshFile = path.join(promptsDir, "rescue-fresh-bbbbbb.md");
  fs.writeFileSync(oldFile, "stale prompt\n", "utf8");
  fs.writeFileSync(freshFile, "recent prompt\n", "utf8");

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
  fs.utimesSync(freshFile, oneDayAgo, oneDayAgo);

  const result = promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
});

test("task --prompt-file reads the path printed by prompt-path and forwards its content as the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const pathResult = promptPath(["--cwd", repo, "--label", "rescue"], { cwd: repo, env });
  assert.equal(pathResult.status, 0, pathResult.stderr);
  const promptFile = pathResult.stdout.trim();

  fs.writeFileSync(promptFile, "Investigate the flaky retry test.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--prompt-file", promptFile], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /Investigate the flaky retry test\./);
});

test("task --background --prompt-file reads the file once up front, not from the detached worker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const pathResult = promptPath(["--cwd", repo, "--label", "rescue"], { cwd: repo, env });
  const promptFile = pathResult.stdout.trim();
  fs.writeFileSync(promptFile, "Background rescue prompt.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--background", "--prompt-file", promptFile], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);

  // Deleting the prompt file right after the foreground `task --background`
  // call returns proves the content was already captured into the queued
  // job's stored request — a worker that re-reads the path later would fail.
  fs.rmSync(promptFile, { force: true });

  const statePath = path.join(binDir, "fake-codex-state.json");
  // A scaled budget, not the 5s default: this waits on a detached worker
  // process, which is exactly the kind of real spawn+IPC work that loses to
  // CPU contention from the rest of the suite running concurrently (see
  // TIMEOUT_SCALE in helpers.mjs).
  const fakeState = await waitFor(
    () => {
      if (!fs.existsSync(statePath)) {
        return null;
      }
      const candidate = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return candidate.lastTurnStart?.prompt?.includes("Background rescue prompt.") ? candidate : null;
    },
    { timeoutMs: scaleTimeout(5000) }
  );

  assert.match(fakeState.lastTurnStart.prompt, /Background rescue prompt\./);
});
