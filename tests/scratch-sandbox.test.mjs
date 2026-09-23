import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { validateScratchSandboxThreadStart } from "../plugins/codex/scripts/lib/scratch-sandbox.mjs";
import {
  acquireScratchSandboxLock,
  resetScratchSandboxDir,
  resolveScratchSandboxDir,
  resolveStateDir,
  upsertJob
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

test(
  "resetScratchSandboxDir refuses when stateDir is a junction whose TARGET already contains a decoy scratch directory (code-review finding CRITICAL #1, second round)",
  { skip: !canCreateJunctions() && "cannot create Windows junctions in this sandbox (no privilege) — see canCreateJunctions()" },
  () => {
    // The specific gap the first round's check missed: assertPathIsPlainDescendant(stateDir, scratchDir)
    // only ever lstats path components BELOW stateDir — it never looks at
    // stateDir itself. So a junction sitting exactly AT stateDir's own slot,
    // whose target already happens to contain a "scratch" subdirectory, would
    // sail through that check while every read/write/delete actually landed
    // in the junction's target instead of the real state directory.
    const repo = makeTempDir();
    const stateDir = resolveStateDir(repo);
    fs.mkdirSync(path.dirname(stateDir), { recursive: true });

    const decoyTarget = makeTempDir();
    const decoyScratch = path.join(decoyTarget, "scratch");
    fs.mkdirSync(decoyScratch, { recursive: true });
    const decoyCanary = path.join(decoyScratch, "canary.txt");
    fs.writeFileSync(decoyCanary, "must survive\n");

    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.symlinkSync(decoyTarget, stateDir, "junction");

    try {
      assert.throws(() => resetScratchSandboxDir(repo), /symlink\/junction|resolves outside/);
      // The decoy "scratch" directory the junction's target already had must
      // not have been touched — proof the code never got as far as clearing
      // it.
      assert.equal(fs.readFileSync(decoyCanary, "utf8"), "must survive\n");
    } finally {
      try {
        fs.rmSync(stateDir, { force: true });
      } catch {
        // best-effort cleanup of the junction itself
      }
    }
  }
);

test(
  "resetScratchSandboxDir does not follow a junction placed directly inside scratch when clearing it",
  { skip: !canCreateJunctions() && "cannot create Windows junctions in this sandbox (no privilege) — see canCreateJunctions()" },
  () => {
    // TOCTOU threat-model note in lib/state.mjs: a junction that is itself
    // one of scratch's own ENTRIES (as opposed to sitting somewhere on the
    // path leading up to scratch) must be removed as the link, never
    // dereferenced into its target — fs.rmSync's recursive delete lstats
    // every path it descends into, so this should hold structurally, but is
    // worth proving directly since it is the other half of that threat model.
    const repo = makeTempDir();
    const dir = resetScratchSandboxDir(repo);

    const elsewhere = makeTempDir();
    const canary = path.join(elsewhere, "canary.txt");
    fs.writeFileSync(canary, "must survive\n");
    fs.symlinkSync(elsewhere, path.join(dir, "junction-entry"), "junction");

    const dirAgain = resetScratchSandboxDir(repo);

    assert.equal(dirAgain, dir);
    assert.deepEqual(fs.readdirSync(dir), [], "the junction entry itself must be gone from scratch");
    assert.equal(fs.readFileSync(canary, "utf8"), "must survive\n", "the junction's TARGET must be untouched");
  }
);

// ---------------------------------------------------------------------------
// acquireScratchSandboxLock — serializes concurrent --scratch-sandbox runs
// on the same repository (code-review finding IMPORTANT #4)
// ---------------------------------------------------------------------------

test("acquireScratchSandboxLock: a second acquire on the same repo times out while the first holder is alive", async () => {
  const repo = makeTempDir();
  // Registered as "running" so the jobId/terminal-status staleness rule
  // (see isScratchSandboxLockStale) does not itself treat this lock as
  // stale just because "job-a" is absent from the index — in real usage
  // the job record always exists (running) by the time the lock is
  // acquired, see runTrackedJob's upsertJob call before invoking the
  // runner in lib/tracked-jobs.mjs.
  upsertJob(repo, { id: "job-a", status: "running" });
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
  upsertJob(repo, { id: "job-a", status: "running" });
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
    JSON.stringify({ pid: deadPid, jobId: "stale-job", startedAt: new Date().toISOString() })
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

// NOTE on scope: within a SINGLE Node process, two `acquireScratchSandboxLock`
// calls made back-to-back never actually interleave — the whole winning path
// is synchronous (no `await` between the EEXIST check and a successful
// reclaim), so the second call only starts once the first has already run to
// completion. This test below is still worth having (it proves a WINNER's
// freshly-registered lock is correctly treated as non-stale by the other
// side, i.e. the jobId/index rule from finding IMPORTANT #4 does not itself
// cause a false double-win) — but it does NOT exercise, and would NOT catch a
// regression in, the atomic rename-based takeover from finding IMPORTANT #3.
// That one needs two independent OS processes actually racing — see
// "acquireScratchSandboxLock: two independent OS processes racing on the
// same stale lock" further below, which uses scratch-lock-race-child.mjs.
test("acquireScratchSandboxLock: two same-process acquirers racing on the same stale lock — exactly one wins immediately, not both", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);
  fs.writeFileSync(
    path.join(stateDir, "scratch.lock"),
    JSON.stringify({ pid: deadPid, jobId: "stale-job", startedAt: new Date().toISOString() })
  );
  // Both racers' own jobs registered as "running" up front — otherwise
  // whichever one wins the stale-lock takeover writes a lock whose jobId
  // ("job-a"/"job-b") is NOT yet in the index, and the loser's own
  // staleness check would treat that freshly-won lock as stale too (via the
  // "jobId missing from the index" rule) and wrongly reclaim it right away,
  // exactly the double-win this test exists to catch. In real usage the job
  // record always exists (running) before the lock is acquired — see
  // runTrackedJob's upsertJob call in lib/tracked-jobs.mjs.
  upsertJob(repo, { id: "job-a", status: "running" });
  upsertJob(repo, { id: "job-b", status: "running" });

  let releaseA = null;
  let releaseB = null;
  const acquireA = acquireScratchSandboxLock(repo, "job-a", { timeoutMs: 4000, pollIntervalMs: 100 }).then((release) => {
    releaseA = release;
  });
  const acquireB = acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 4000, pollIntervalMs: 100 }).then((release) => {
    releaseB = release;
  });

  // Wait for at least one to win, then give the other every chance to
  // (wrongly) sneak in too before checking.
  await Promise.race([acquireA, acquireB]);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const winnersSoFar = [releaseA, releaseB].filter(Boolean);
  assert.equal(winnersSoFar.length, 1, "exactly one of the two racing acquirers must hold the lock at this point");

  // Release the winner and confirm the loser now gets its turn — not stuck
  // forever, and not holding the lock simultaneously with the first.
  winnersSoFar[0]();
  await Promise.race([acquireA, acquireB]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const bothNow = [releaseA, releaseB].filter(Boolean);
  assert.equal(bothNow.length, 2, "the loser must acquire the lock once the winner releases it");

  releaseA?.();
  releaseB?.();
});

test("acquireScratchSandboxLock: a lock whose recorded job has already reached a terminal status is reclaimed even though its pid is alive", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  // Our OWN pid is guaranteed alive for the duration of this test, so only
  // the jobId/terminal-status rule — not pid liveness — can explain a
  // successful reclaim here (code-review finding IMPORTANT #4, second
  // round: an OS pid reused by an unrelated process must not be mistaken
  // for the original holder still running).
  upsertJob(repo, { id: "reused-pid-job", status: "completed" });
  fs.writeFileSync(
    path.join(stateDir, "scratch.lock"),
    JSON.stringify({ pid: process.pid, jobId: "reused-pid-job", startedAt: new Date().toISOString() })
  );

  const start = Date.now();
  const release = await acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 60000, pollIntervalMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `a lock for an already-terminal job must be reclaimed immediately (waited ${elapsed}ms)`);
  release();
});

test("acquireScratchSandboxLock: a lock whose recorded jobId is missing from the job index entirely is reclaimed", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "scratch.lock"),
    JSON.stringify({ pid: process.pid, jobId: "no-such-job", startedAt: new Date().toISOString() })
  );

  const start = Date.now();
  const release = await acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 60000, pollIntervalMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `a lock whose job is missing from the index must be reclaimed immediately (waited ${elapsed}ms)`);
  release();
});

test("acquireScratchSandboxLock: a lock for a job that is still running, held by a live pid, is NOT reclaimed", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });

  upsertJob(repo, { id: "still-running-job", status: "running" });
  fs.writeFileSync(
    path.join(stateDir, "scratch.lock"),
    JSON.stringify({ pid: process.pid, jobId: "still-running-job", startedAt: new Date().toISOString() })
  );

  const start = Date.now();
  await assert.rejects(
    acquireScratchSandboxLock(repo, "job-b", { timeoutMs: 400, pollIntervalMs: 50 }),
    /busy with job still-running-job/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 350, "must actually wait out the timeout, not be reclaimed early");
});

// ---------------------------------------------------------------------------
// Cross-process contention (code-review finding IMPORTANT #3, second round):
// the atomic rename-based stale-lock takeover matters only when two
// INDEPENDENT processes race — see the NOTE above the same-process test.
// ---------------------------------------------------------------------------

const RACE_CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scratch-lock-race-child.mjs");

function runRaceChild(repo, jobId, markerFile, holdMs, readyFile, goFile, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [RACE_CHILD_SCRIPT, repo, jobId, markerFile, String(holdMs), readyFile, goFile],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...envOverrides } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`race child for ${jobId} exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("acquireScratchSandboxLock: two independent OS processes racing on the same stale lock never both hold it at once", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  upsertJob(repo, { id: "race-job-a", status: "running" });
  upsertJob(repo, { id: "race-job-b", status: "running" });

  const holdMs = 400;
  let bothHeldAtOnce = false;

  // Run several rounds: even with the ready/go synchronization below
  // tightening the race window, OS scheduling jitter means a single round is
  // not guaranteed to hit the narrow unlink-then-create gap a naive (pre-fix)
  // takeover has. This loop is what makes the mutation check in the review
  // reliable — see the commit message for the actual before/after run.
  for (let round = 0; round < 5 && !bothHeldAtOnce; round += 1) {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    assert.ok(Number.isInteger(deadPid) && deadPid > 0);
    fs.writeFileSync(
      path.join(stateDir, "scratch.lock"),
      JSON.stringify({ pid: deadPid, jobId: "stale-job", startedAt: new Date().toISOString() })
    );

    const markerA = path.join(stateDir, `marker-a-${round}.txt`);
    const markerB = path.join(stateDir, `marker-b-${round}.txt`);
    const readyA = path.join(stateDir, `ready-a-${round}.txt`);
    const readyB = path.join(stateDir, `ready-b-${round}.txt`);
    const goFile = path.join(stateDir, `go-${round}.txt`);

    const pollTimer = setInterval(() => {
      if (fs.existsSync(markerA) && fs.existsSync(markerB)) {
        bothHeldAtOnce = true;
      }
    }, 5);

    try {
      const childA = runRaceChild(repo, "race-job-a", markerA, holdMs, readyA, goFile);
      const childB = runRaceChild(repo, "race-job-b", markerB, holdMs, readyB, goFile);

      // Only release both children to actually attempt the acquire once
      // BOTH have loaded and are busy-polling for `goFile` — tightens the
      // race to well under the process-spawn jitter that would otherwise
      // dominate (spawning a new Node process routinely takes tens of ms,
      // which would usually separate two plain back-to-back spawns enough
      // for even a naive takeover to "happen" to work).
      await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
      fs.writeFileSync(goFile, "go");

      const [stdoutA, stdoutB] = await Promise.all([childA, childB]);
      assert.match(stdoutA, /acquired/);
      assert.match(stdoutB, /acquired/);
    } finally {
      clearInterval(pollTimer);
    }

    assert.equal(fs.existsSync(markerA), false);
    assert.equal(fs.existsSync(markerB), false);
  }

  assert.equal(bothHeldAtOnce, false, "the two racing processes must never hold the scratch lock at the same time, in any round");
});

test("acquireScratchSandboxLock: a takeover that lands after the other racer already published its fresh lock puts it back instead of stealing it (deterministic, via CODEX_COMPANION_SCRATCH_LOCK_DEBUG_DELAY_MS)", async () => {
  // The two-OS-process test above relies on incidental scheduler timing to
  // hit the narrow window between a racer's rename and its own wx-create —
  // reliable in practice (checked across several runs) but not guaranteed
  // on every machine. This test instead deterministically reproduces the
  // WIDER version of the same race — a racer delayed long enough that the
  // OTHER side has already fully published its fresh lock before the
  // delayed racer's rename fires — using the DEBUG_DELAY_MS test hook in
  // lib/state.mjs. Without the identity-verification step this test guards
  // (comparing what renameSync actually moved against what was originally
  // read as stale, and putting it back on a mismatch instead of treating it
  // as a legitimate takeover), this reliably reproduces a double-hold.
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  upsertJob(repo, { id: "race-job-a", status: "running" });
  upsertJob(repo, { id: "race-job-b", status: "running" });

  let bothHeldAtOnce = false;

  // Even with the delay hook widening the window, the EXACT interleaving
  // still depends on real OS scheduling (how promptly each child's rename
  // syscall actually runs once its delay elapses) — a handful of rounds
  // makes this reliable without depending on any single round's luck.
  for (let round = 0; round < 5 && !bothHeldAtOnce; round += 1) {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    assert.ok(Number.isInteger(deadPid) && deadPid > 0);
    fs.writeFileSync(
      path.join(stateDir, "scratch.lock"),
      JSON.stringify({ pid: deadPid, jobId: "stale-job", startedAt: new Date().toISOString() })
    );

    const markerA = path.join(stateDir, `marker-a-${round}.txt`);
    const markerB = path.join(stateDir, `marker-b-${round}.txt`);
    const readyA = path.join(stateDir, `ready-a-${round}.txt`);
    const readyB = path.join(stateDir, `ready-b-${round}.txt`);
    const goFile = path.join(stateDir, `go-${round}.txt`);

    const pollTimer = setInterval(() => {
      if (fs.existsSync(markerA) && fs.existsSync(markerB)) {
        bothHeldAtOnce = true;
      }
    }, 5);

    try {
      // A takes the stale lock over immediately (no delay); B is held back
      // long enough for A to fully complete its rename-then-create cycle
      // before B's own (equally "the lock looked stale when I checked")
      // rename attempt fires.
      const childA = runRaceChild(repo, "race-job-a", markerA, 300, readyA, goFile);
      const childB = runRaceChild(repo, "race-job-b", markerB, 300, readyB, goFile, {
        CODEX_COMPANION_SCRATCH_LOCK_DEBUG_DELAY_MS: "30"
      });

      await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
      fs.writeFileSync(goFile, "go");

      const [stdoutA, stdoutB] = await Promise.all([childA, childB]);
      assert.match(stdoutA, /acquired/);
      assert.match(stdoutB, /acquired/);
    } finally {
      clearInterval(pollTimer);
    }

    assert.equal(fs.existsSync(markerA), false);
    assert.equal(fs.existsSync(markerB), false);
  }

  assert.equal(bothHeldAtOnce, false, "B's delayed takeover must detect A's fresh lock and back off, not steal it, in any round");
});
