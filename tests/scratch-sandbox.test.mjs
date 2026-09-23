import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { validateScratchSandboxThreadStart } from "../plugins/codex/scripts/lib/scratch-sandbox.mjs";
import {
  acquireScratchSandboxLock,
  resetScratchSandboxDir,
  resolveScratchSandboxDir,
  resolveStateDir
} from "../plugins/codex/scripts/lib/state.mjs";

// ---------------------------------------------------------------------------
// validateScratchSandboxThreadStart — fail-closed check of the app-server's
// ACTUAL thread/start response, called before turn/start ever runs. Each
// mismatch case below is mutation-provable on its own: comment out the
// corresponding `errors.push` line in lib/scratch-sandbox.mjs and the
// matching test here fails (it currently only passes because the check is
// live). The "accepted" cases guard the other direction — a correct policy
// must not be rejected.
// ---------------------------------------------------------------------------

const SCRATCH = "C:/scratch/repo-abc";
const REPO = "C:/Users/dev/repo-abc";

function goodResponse({ cwd = SCRATCH, sandbox = {} } = {}) {
  return {
    cwd,
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
      ...sandbox
    }
  };
}

test("validateScratchSandboxThreadStart accepts a correct ack with EMPTY writableRoots", () => {
  // codex-cli 0.153.4 always returns writableRoots: [] on thread/start
  // regardless of the writable_roots override actually applied (see the
  // comment in lib/scratch-sandbox.mjs) — this must NOT be rejected, or the
  // flag would never work against a real app-server.
  const effective = validateScratchSandboxThreadStart(goodResponse(), { scratchDir: SCRATCH, repoRoot: REPO });
  assert.deepEqual(effective, {
    type: "workspaceWrite",
    cwd: SCRATCH,
    writableRoots: [],
    networkAccess: false
  });
});

test("validateScratchSandboxThreadStart accepts a correct ack whose writableRoots is exactly [scratch]", () => {
  const response = goodResponse({ sandbox: { writableRoots: [SCRATCH] } });
  const effective = validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO });
  assert.deepEqual(effective.writableRoots, [SCRATCH]);
});

test("validateScratchSandboxThreadStart rejects a cwd that is not the scratch directory", () => {
  const response = goodResponse({ cwd: REPO });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /resolved cwd .* is not the scratch directory/
  );
});

test("validateScratchSandboxThreadStart rejects a sandbox type other than workspaceWrite", () => {
  const response = goodResponse({ sandbox: { type: "readOnly", writableRoots: undefined, excludeTmpdirEnvVar: undefined, excludeSlashTmp: undefined } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /resolved sandbox type is "readOnly", expected "workspaceWrite"/
  );
});

test("validateScratchSandboxThreadStart rejects network access", () => {
  const response = goodResponse({ sandbox: { networkAccess: true } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /network access is true, expected false/
  );
});

test("validateScratchSandboxThreadStart rejects a writable root that is not the scratch directory", () => {
  const response = goodResponse({ sandbox: { writableRoots: ["C:/somewhere/else"] } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /writable root "C:\/somewhere\/else" is not the scratch directory/
  );
});

test("validateScratchSandboxThreadStart rejects a writable root that contains the repository", () => {
  // An ancestor of the repository as a writable root would make the
  // repository itself writable through it, even though it is not literally
  // equal to the repository path.
  const response = goodResponse({ sandbox: { writableRoots: ["C:/Users/dev"] } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /contains the repository/
  );
});

test("validateScratchSandboxThreadStart rejects excludeTmpdirEnvVar=false", () => {
  const response = goodResponse({ sandbox: { excludeTmpdirEnvVar: false } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /excludeTmpdirEnvVar is false, expected true/
  );
});

test("validateScratchSandboxThreadStart rejects excludeSlashTmp=false", () => {
  const response = goodResponse({ sandbox: { excludeSlashTmp: false } });
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    /excludeSlashTmp is false, expected true/
  );
});

test("validateScratchSandboxThreadStart reports every violation, not just the first", () => {
  const response = { cwd: REPO, sandbox: { type: "readOnly", networkAccess: true } };
  assert.throws(
    () => validateScratchSandboxThreadStart(response, { scratchDir: SCRATCH, repoRoot: REPO }),
    (error) => {
      assert.match(error.message, /resolved cwd/);
      assert.match(error.message, /expected "workspaceWrite"/);
      assert.match(error.message, /network access is true/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// resetScratchSandboxDir — safe cleanup (code-review finding CRITICAL #2)
// ---------------------------------------------------------------------------

test("resetScratchSandboxDir creates the scratch directory and clears leftovers on the next run", () => {
  const repo = makeTempDir();
  const dir = resetScratchSandboxDir(repo);
  fs.writeFileSync(path.join(dir, "leftover.txt"), "stale\n");

  const dirAgain = resetScratchSandboxDir(repo);
  assert.equal(dirAgain, dir);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("resetScratchSandboxDir refuses when the repository IS the state directory's root (CLAUDE_PLUGIN_DATA misconfigured inside the repo)", () => {
  const repo = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  // Point the plugin's state root INSIDE the repository — the exact
  // misconfiguration assertNotInsideRepo exists to catch.
  process.env.CLAUDE_PLUGIN_DATA = path.join(repo, "plugin-data");
  try {
    assert.throws(() => resetScratchSandboxDir(repo), /resolves inside the repository/);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

function canCreateJunctions() {
  if (process.platform !== "win32") {
    return false;
  }
  const dir = makeTempDir();
  const target = path.join(dir, "target");
  const link = path.join(dir, "link");
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

test("resetScratchSandboxDir refuses when the state directory's own path passes through a junction", { skip: !canCreateJunctions() && "cannot create Windows junctions in this sandbox (no privilege) — see canCreateJunctions()" }, () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const realStateParent = path.dirname(stateDir);
  fs.mkdirSync(realStateParent, { recursive: true });

  // Replace the state directory's own slot with a junction pointing
  // somewhere else entirely — simulates a reparse point sitting ON the path
  // resetScratchSandboxDir is about to recursively delete under.
  const elsewhere = makeTempDir();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.symlinkSync(elsewhere, stateDir, "junction");

  try {
    // Whichever specific check catches it first — the lstat walk or the
    // realpath-containment fallback — the outcome that matters is refusal;
    // see assertPathIsPlainDescendant in lib/state.mjs for why the realpath
    // check exists as a second, independent layer under the lstat walk.
    assert.throws(() => resetScratchSandboxDir(repo), /symlink\/junction|resolves outside/);
  } finally {
    try {
      fs.rmSync(stateDir, { force: true });
    } catch {
      // best-effort cleanup of the junction itself
    }
  }
});

test("resetScratchSandboxDir refuses when the scratch directory itself has been replaced by a junction", { skip: !canCreateJunctions() && "cannot create Windows junctions in this sandbox (no privilege) — see canCreateJunctions()" }, () => {
  const repo = makeTempDir();
  // First call creates the real scratch dir legitimately.
  const dir = resetScratchSandboxDir(repo);
  const elsewhere = makeTempDir();
  fs.writeFileSync(path.join(elsewhere, "outside-scratch.txt"), "should never be touched\n");

  fs.rmdirSync(dir);
  fs.symlinkSync(elsewhere, dir, "junction");

  try {
    assert.throws(() => resetScratchSandboxDir(repo), /symlink\/junction/);
    // And, crucially: the redirect target must be untouched.
    assert.equal(fs.existsSync(path.join(elsewhere, "outside-scratch.txt")), true);
  } finally {
    try {
      fs.rmSync(dir, { force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// acquireScratchSandboxLock — serializes concurrent --scratch-sandbox runs
// on the same repository (code-review finding IMPORTANT #4)
// ---------------------------------------------------------------------------

test("acquireScratchSandboxLock: a second acquire on the same repo times out while the first holder is alive", async () => {
  const repo = makeTempDir();
  const release = await acquireScratchSandboxLock(repo, "job-a");

  const start = Date.now();
  await assert.rejects(
    acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 400, pollIntervalMs: 50 }),
    /scratch sandbox for this repository is busy with job job-a/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `must not wait anywhere near the 10-minute default (waited ${elapsed}ms)`);

  release();
});

test("acquireScratchSandboxLock: releasing the first holder lets a waiting second acquire proceed", async () => {
  const repo = makeTempDir();
  const release = await acquireScratchSandboxLock(repo, "job-a");

  const secondAcquire = acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 5000, pollIntervalMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  release();

  const releaseSecond = await secondAcquire;
  releaseSecond();
});

test("acquireScratchSandboxLock: a stale lock (dead pid) is reclaimed immediately, not after the timeout", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  // A pid that is guaranteed not to be alive: spawn a trivial child and wait
  // for it to exit, then use its now-dead pid.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);

  fs.writeFileSync(
    path.join(stateDir, "scratch.lock"),
    JSON.stringify({ pid: deadPid, jobId: "stale-job", createdAt: new Date().toISOString() })
  );

  const start = Date.now();
  // Deliberately a LONG timeout — if reclaiming a dead holder's lock worked
  // by waiting it out instead of detecting the dead pid, this test would
  // hang for the full duration instead of returning almost immediately.
  const release = await acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 60000, pollIntervalMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `stale lock must be reclaimed immediately, not after a poll wait (waited ${elapsed}ms)`);

  release();
});
