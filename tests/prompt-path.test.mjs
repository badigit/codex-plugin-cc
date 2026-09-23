import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  assert.match(
    path.basename(printedPath),
    /^rescue-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/
  );

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
  assert.match(
    path.basename(printedPath),
    /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/
  );
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

  const oldFile = path.join(promptsDir, `rescue-${crypto.randomUUID()}.md`);
  const freshFile = path.join(promptsDir, `rescue-${crypto.randomUUID()}.md`);
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

test("prompt-path's age sweep only removes files matching the runtime's own naming pattern, not a stranger's file", () => {
  const workspace = makeTempDir();
  const promptsDir = path.join(resolveStateDir(workspace), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  // Same directory, same age, but not a name the runtime itself would have
  // generated (no UUID suffix) — something a human or another tool dropped
  // in there directly.
  const strangerFile = path.join(promptsDir, "notes.md");
  fs.writeFileSync(strangerFile, "unrelated file, not ours to delete\n", "utf8");
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(strangerFile, eightDaysAgo, eightDaysAgo);

  const result = promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(strangerFile), true);
});

test("prompt-path creates the prompts directory owner-only (0o700) on POSIX", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();

  promptPath(["--cwd", workspace, "--label", "rescue"], { cwd: workspace, env: process.env });

  const promptsDir = path.join(resolveStateDir(workspace), "prompts");
  const mode = fs.statSync(promptsDir).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("two concurrent prompt-path calls for the same workspace never collide on a path", async () => {
  const workspace = makeTempDir();

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, "prompt-path", "--cwd", workspace, "--label", "rescue"], {
          cwd: workspace,
          env: process.env,
          windowsHide: true
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`prompt-path exited with code ${code}`));
            return;
          }
          resolve(stdout.trim());
        });
      })
    )
  );

  assert.equal(results.length, 10);
  assert.equal(new Set(results).size, 10);
  for (const printedPath of results) {
    assert.equal(fs.existsSync(printedPath), false);
  }
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

  // A one-shot prompt file is deleted right after `task` reads it — waiting
  // for the next `prompt-path` call's age sweep would leave a prompt that may
  // carry client data on disk for up to 7 days.
  assert.equal(fs.existsSync(promptFile), false);
});

test("task --prompt-file leaves a caller-owned file outside the prompts directory untouched", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const ownFile = path.join(repo, "my-own-prompt.md");
  fs.writeFileSync(ownFile, "A prompt file the caller wrote and manages itself.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--prompt-file", ownFile], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /A prompt file the caller wrote and manages itself\./);

  // Only files inside <stateDir>/prompts are the runtime's to delete. A file
  // the caller passed in from elsewhere is never the runtime's to remove.
  assert.equal(fs.existsSync(ownFile), true);
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

  // `task` deletes a one-shot prompt file itself, synchronously, in the
  // foreground call that queues the background job — before any worker has
  // even started. This already proves the content was captured into the
  // queued job's stored request rather than left for a worker to re-read the
  // path later, but rmSync below (force: true, so it is a no-op here) keeps
  // the test explicit about what property is being exercised.
  assert.equal(fs.existsSync(promptFile), false);
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

// Regression: readTaskPrompt gained a --prompt-file branch, but the two
// pre-existing ways of supplying a prompt — positional text and piped stdin —
// must keep working exactly as before.
test("task still accepts a positional prompt (no --prompt-file involved)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const result = run("node", [SCRIPT, "task", "investigate the positional prompt path"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /investigate the positional prompt path/);
});

test("task still accepts a prompt piped over stdin (no --prompt-file involved)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const result = run("node", [SCRIPT, "task"], {
    cwd: repo,
    env,
    input: "investigate the piped stdin prompt path\n"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /investigate the piped stdin prompt path/);
});

// Review round 2 (78f99d2 -> this commit): deletion used to happen inside
// readTaskPrompt, before ANY precondition check — a flag conflict, a missing
// Codex install, or (as here) --resume-last finding no prior thread would
// still burn the one-shot prompt file even though the task was never
// accepted. Deletion now happens only once handleTask reaches the point
// where the job is durably queued (background) or the foreground run
// actually executed past every precondition (see the comments next to both
// consumeOneShotPromptFile call sites in handleTask).
test("task --prompt-file --resume-last errors when no prior thread exists, and leaves the prompt file in place", () => {
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
  fs.writeFileSync(promptFile, "Resume the previous rescue run.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--prompt-file", promptFile, "--resume-last"], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous Codex task thread was found for this repository\./);
  assert.equal(fs.existsSync(promptFile), true);
});

test("task --prompt-file leaves an in-prompts-dir file alone when its name doesn't match prompt-path's naming pattern", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const promptsDir = path.join(resolveStateDir(repo), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  // Same directory a real prompt-path file would live in, but a name
  // prompt-path never generates (no uuid suffix) — e.g. something a human
  // dropped in there directly.
  const foreignNamedFile = path.join(promptsDir, "notes.md");
  fs.writeFileSync(foreignNamedFile, "Not something prompt-path generated.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--prompt-file", foreignNamedFile], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(foreignNamedFile), true);
});

test(
  "task --prompt-file refuses to delete through a symlink, even one named like a prompt-path file",
  (t) => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    const env = buildEnv(binDir);
    const promptsDir = path.join(resolveStateDir(repo), "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const outsideDir = makeTempDir();
    const outsideTarget = path.join(outsideDir, "outside-target.md");
    fs.writeFileSync(outsideTarget, "Should never be deleted through the symlink.\n", "utf8");

    // A name that DOES match PROMPT_FILE_NAME_PATTERN, so this isolates the
    // symlink check from the name-pattern check above.
    const symlinkPath = path.join(promptsDir, `rescue-${crypto.randomUUID()}.md`);
    try {
      fs.symlinkSync(outsideTarget, symlinkPath, "file");
    } catch (error) {
      // Creating a symlink needs elevated privileges or Developer Mode on
      // Windows without them (same environment gap worktree.test.mjs's
      // symlink tests hit) — skip rather than fail on an unrelated cause.
      t.skip(`cannot create filesystem symlinks in this environment: ${error.message}`);
      return;
    }

    const result = run("node", [SCRIPT, "task", "--prompt-file", symlinkPath], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(symlinkPath), true);
    assert.equal(fs.existsSync(outsideTarget), true);
  }
);
