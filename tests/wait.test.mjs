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

function initRepoWithCommit(repo) {
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

// Mirrors codex-companion.mjs's buildCompanionCommand quoting exactly (it is
// not exported) so the retry-command assertions below can compare the WHOLE
// string, not just check that `wait <id> --cwd` appears somewhere in it —
// code-review finding #2 wants the caller's own flags (--timeout-ms, --json)
// preserved verbatim in the retry line, and a substring match would not catch
// them silently going missing.
function quoteArg(part) {
  const text = process.platform === "win32" ? String(part).replace(/\\/g, "/") : String(part);
  return /[\s"']/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}
function expectedWaitCommand(args) {
  return ["node", SCRIPT, ...args].map(quoteArg).join(" ");
}

function launchBackgroundTask(repo, binDir, prompt) {
  const launched = run("node", [SCRIPT, "task", "--background", "--json", prompt], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout);
}

// `wait <job-id>` collapses `status <id> --wait` + `result <id>` into a
// single call: exit 0 (completed) / 1 (failed or cancelled) / 2 (still
// queued/running when --timeout-ms ran out). See codex-companion.mjs's
// handleWait for why: a forwarding subagent's own "finished" notification is
// not the Codex turn finishing, so the caller needs one call whose exit
// carries the outcome and whose stdout already is the collected answer.

test("wait collects a completed background task's result in one call", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initRepoWithCommit(repo);

  const launchPayload = launchBackgroundTask(repo, binDir, "investigate the flaky worker timeout");
  assert.equal(launchPayload.status, "queued");

  const waited = run("node", [SCRIPT, "wait", launchPayload.jobId, "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir),
    // Leave headroom over the fixture's own 400ms delayed turn/completed.
    timeout: scaleTimeout(20000)
  });

  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /Handled the requested task\.\s*\nTask prompt accepted\./);
  assert.match(waited.stdout, /Codex session ID: thr_[a-z0-9]+/i);

  // Same outcome via --json: the job/storedJob shape `result --json` already
  // returns, not a bespoke payload shape.
  const waitedJson = run("node", [SCRIPT, "wait", launchPayload.jobId, "--cwd", repo, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(waitedJson.status, 0, waitedJson.stderr);
  const payload = JSON.parse(waitedJson.stdout);
  assert.equal(payload.job.id, launchPayload.jobId);
  assert.equal(payload.job.status, "completed");
  assert.match(payload.storedJob.result.rawOutput, /Task prompt accepted\./);
});

test("wait reports a failed background task's reason with exit code 1", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-fails");
  initRepoWithCommit(repo);

  const launchPayload = launchBackgroundTask(repo, binDir, "diagnose the failing test");

  const waited = run("node", [SCRIPT, "wait", launchPayload.jobId, "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir),
    timeout: scaleTimeout(20000)
  });

  assert.equal(waited.status, 1, waited.stderr);
  assert.match(waited.stdout, /turn\/start failed after thread resolution/);

  const waitedJson = run("node", [SCRIPT, "wait", launchPayload.jobId, "--cwd", repo, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(waitedJson.status, 1, waitedJson.stderr);
  const payload = JSON.parse(waitedJson.stdout);
  assert.equal(payload.job.status, "failed");
  assert.match(payload.job.errorMessage, /turn\/start failed after thread resolution/);
});

test("wait exits 2 with a retry line when --timeout-ms runs out while the job is still active, without marking it failed", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    `${JSON.stringify({ id: "task-live", status: "running", title: "Codex Task", logFile }, null, 2)}\n`,
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

  const result = run("node", [SCRIPT, "wait", "task-live", "--timeout-ms", "25", "--cwd", workspace], {
    cwd: workspace
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /task-live has not finished yet \(running\)/);
  // The retry line must carry the SAME --timeout-ms the caller passed, not
  // drop it and hand back a 30-minute default retry — and must NOT gain a
  // --json the caller never asked for.
  const expectedTextRetry = expectedWaitCommand(["wait", "task-live", "--cwd", workspace, "--timeout-ms", "25"]);
  assert.ok(
    result.stdout.includes(`Retry: ${expectedTextRetry}`),
    `expected retry command ${JSON.stringify(expectedTextRetry)} in:\n${result.stdout}`
  );

  const resultJson = run(
    "node",
    [SCRIPT, "wait", "task-live", "--timeout-ms", "25", "--poll-interval-ms", "10", "--cwd", workspace, "--json"],
    { cwd: workspace }
  );
  assert.equal(resultJson.status, 2, resultJson.stderr);
  const payload = JSON.parse(resultJson.stdout);
  assert.equal(payload.status, "timeout");
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  const expectedJsonRetry = expectedWaitCommand([
    "wait",
    "task-live",
    "--cwd",
    workspace,
    "--timeout-ms",
    "25",
    "--poll-interval-ms",
    "10",
    "--json"
  ]);
  assert.equal(payload.retryCommand, expectedJsonRetry);

  // Timing out must not touch the job's own status — it is still running,
  // not failed, and a later `wait` must find the same live job.
  const persistedState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(persistedState.jobs[0].status, "running");
});

// Regression for the live race seen 23.09.2026: `task --background` had
// already returned (the launch line and job id were printed), but the very
// first `wait` lookup for that job id still hit job-control.mjs's "No job
// found" — the detached worker's own first index write had not landed yet.
// `wait` must retry that ONE specific error, bounded, rather than surface it
// as a hard failure on a job id it was itself just handed.
test("wait retries a transient \"No job found\" while the background worker's index entry is still landing", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-appear-later";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const stateFile = path.join(stateDir, "state.json");
  const appearDelayMs = scaleTimeout(500);

  // Independent OS process, not a timer in this test's own event loop: the
  // `wait` call below is a blocking spawnSync, so anything scheduled on this
  // process's event loop would never actually fire while it blocks.
  const writerSource = `
    const fs = require("fs");
    setTimeout(() => {
      const job = {
        id: ${JSON.stringify(jobId)},
        status: "completed",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        logFile: ${JSON.stringify(logFile)},
        threadId: "thr_appear_later",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: { rawOutput: "Answer landed after the index caught up." },
        rendered: "Answer landed after the index caught up.\\n"
      };
      fs.writeFileSync(${JSON.stringify(logFile)}, "", "utf8");
      fs.writeFileSync(${JSON.stringify(jobFile)}, JSON.stringify(job, null, 2) + "\\n", "utf8");
      fs.writeFileSync(
        ${JSON.stringify(stateFile)},
        JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2) + "\\n",
        "utf8"
      );
    }, ${appearDelayMs});
  `;
  const writer = spawn(process.execPath, ["-e", writerSource], { stdio: "ignore" });

  try {
    const result = run(
      "node",
      [SCRIPT, "wait", jobId, "--cwd", workspace, "--poll-interval-ms", "100", "--json"],
      { cwd: workspace }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.job.id, jobId);
    assert.equal(payload.job.status, "completed");
    assert.match(payload.storedJob.result.rawOutput, /Answer landed after the index caught up\./);
  } finally {
    writer.kill();
  }
});

test("wait fails after the retry budget for a job id that genuinely does not exist", () => {
  const workspace = makeTempDir();

  const result = run(
    "node",
    [SCRIPT, "wait", "task-does-not-exist", "--cwd", workspace, "--poll-interval-ms", "100"],
    { cwd: workspace, env: { ...process.env, CODEX_COMPANION_WAIT_INDEX_RETRY_MS: "150" } }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No job found for "task-does-not-exist"/);
});

// Code-review finding #1 on the first cut: the job-index-appear wait and the
// active-status wait were two INDEPENDENT budgets stacked back to back, so a
// caller's own --timeout-ms only bounded the second half — a job id that
// never appears at all waited out the full 15s default regardless of what
// --timeout-ms said. There is now one deadline for the whole call.
test("wait's --timeout-ms bounds the WHOLE call, including the job-index-appear wait, not just the active-status wait", () => {
  const workspace = makeTempDir();

  const startedAt = Date.now();
  const result = run(
    "node",
    [SCRIPT, "wait", "typo-job-id", "--timeout-ms", "1000", "--poll-interval-ms", "2000", "--cwd", workspace],
    { cwd: workspace }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No job found for "typo-job-id"/);
  // Must stop close to the requested 1000ms, not the 15s index-retry default
  // (WAIT_JOB_INDEX_RETRY_MS) the earlier, unbounded version fell back to.
  // Deliberately NOT scaleTimeout()'d: the old bug's duration is a flat
  // 15000ms regardless of machine load (a plain constant, not real spawned
  // work), so a scaled bound could exceed it under heavy contention and stop
  // telling the two apart. 6000ms unscaled stays a decisive margin above the
  // expected ~1000-1500ms and well under the 15000ms bug it must catch.
  assert.ok(
    elapsedMs < 6000,
    `expected wait to give up near --timeout-ms 1000, took ${elapsedMs}ms`
  );
});

// Second review round: an explicit zero budget (`--timeout-ms 0`, or a
// negative value normalized to 0) was treated as "unset" by `x || default`
// and silently became the 15s index-retry default.
test("wait with a zero --timeout-ms does not fall back to the 15s index-retry default", () => {
  const workspace = makeTempDir();

  const startedAt = Date.now();
  const result = run(
    "node",
    [SCRIPT, "wait", "typo-job-id", "--timeout-ms", "0", "--cwd", workspace],
    { cwd: workspace }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No job found for "typo-job-id"/);
  assert.ok(elapsedMs < 6000, `expected an immediate give-up for --timeout-ms 0, took ${elapsedMs}ms`);
});

test("a job that appears mid-wait is only waited for the REMAINDER of --timeout-ms, not a fresh full budget", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-appear-still-running";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const stateFile = path.join(stateDir, "state.json");
  // Appears partway through the caller's own --timeout-ms budget below, and
  // stays "running" forever after that — so the ONLY way this call can time
  // out at all is if the active-status wait actually got bounded by what was
  // left of the total budget, not a fresh one.
  const appearDelayMs = scaleTimeout(1200);
  const totalTimeoutMs = scaleTimeout(3000);

  const writerSource = `
    const fs = require("fs");
    setTimeout(() => {
      const job = {
        id: ${JSON.stringify(jobId)},
        status: "running",
        phase: "running",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        logFile: ${JSON.stringify(logFile)},
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(${JSON.stringify(logFile)}, "", "utf8");
      fs.writeFileSync(${JSON.stringify(jobFile)}, JSON.stringify(job, null, 2) + "\\n", "utf8");
      fs.writeFileSync(
        ${JSON.stringify(stateFile)},
        JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2) + "\\n",
        "utf8"
      );
    }, ${appearDelayMs});
  `;
  const writer = spawn(process.execPath, ["-e", writerSource], { stdio: "ignore" });

  try {
    const startedAt = Date.now();
    const result = run(
      "node",
      [SCRIPT, "wait", jobId, "--timeout-ms", String(totalTimeoutMs), "--poll-interval-ms", "100", "--cwd", workspace],
      { cwd: workspace }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, new RegExp(`${jobId} has not finished yet`));
    // The old (finding-#1) behavior: appear-wait (~1.2s) THEN a fresh full
    // active-status wait (~3s) => ~4.2s total. The unified-deadline behavior:
    // the whole call is bounded by totalTimeoutMs (~3s), so it must finish
    // well under appearDelayMs + totalTimeoutMs.
    assert.ok(
      elapsedMs < appearDelayMs + totalTimeoutMs - scaleTimeout(500),
      `expected the call to respect ONE shared deadline (~${totalTimeoutMs}ms total), took ${elapsedMs}ms`
    );
  } finally {
    writer.kill();
  }
});

test("wait reports a cancelled background task with exit code 1", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-cancelled";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const job = {
    id: jobId,
    status: "cancelled",
    phase: "cancelled",
    title: "Codex Task",
    jobClass: "task",
    summary: "Investigate flaky test",
    logFile,
    errorMessage: "Cancelled by user.",
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    completedAt: "2026-03-18T15:30:03.000Z",
    cancelledAt: "2026-03-18T15:30:03.000Z"
  };
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "wait", jobId, "--cwd", workspace], { cwd: workspace });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Cancelled by user\./);

  const resultJson = run("node", [SCRIPT, "wait", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
  assert.equal(resultJson.status, 1, resultJson.stderr);
  const payload = JSON.parse(resultJson.stdout);
  assert.equal(payload.job.status, "cancelled");
});

test("wait reports a meaningful reason for a failed job that never got its own errorMessage, not an empty result", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-failed-no-message";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  // Deliberately no errorMessage on the job AND no storedJob.result/rendered —
  // the shape a worker crash outside runTrackedJob's own catch could leave
  // behind. renderStoredJobResult's fallback must still surface status and
  // summary rather than printing nothing.
  const job = {
    id: jobId,
    status: "failed",
    phase: "failed",
    title: "Codex Task",
    jobClass: "task",
    summary: "Investigate the flaky worker timeout",
    logFile,
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    completedAt: "2026-03-18T15:30:03.000Z"
  };
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "wait", jobId, "--cwd", workspace], { cwd: workspace });

  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(result.stdout.trim(), "");
  assert.match(result.stdout, /Status: failed/);
  assert.match(result.stdout, /Investigate the flaky worker timeout/);
});
