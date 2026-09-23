import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

// A local copy of scripts/delegate/schemas/review-findings.json from the
// tooling workshop (_my_llm-skills-agents), which this repo does not depend
// on and cannot read at test time. `line` is nullable — not every finding
// points at a specific line — and there is no `summary`/`next_steps`: the
// real schema is verdict + findings only. A `verdict` property is also what
// the fake app-server keys off to decide it should hand back structured JSON
// instead of plain task text (see fake-codex-fixture.mjs's turn/start
// handler and its generic structuredReviewPayload() fallback, which is
// shaped to match this schema).
const REVIEW_FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "needs-attention", "reject"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "claim", "evidence", "repro"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          claim: { type: "string" },
          evidence: { type: "string" },
          repro: { type: "string" }
        }
      }
    }
  }
};

// What the fake app-server answers for REVIEW_FINDINGS_SCHEMA outside the
// adversarial-review prompt (see structuredReviewPayload()'s generic
// fallback in fake-codex-fixture.mjs).
const APPROVE_ANSWER = { verdict: "approve", findings: [] };

// Deliberately lacks a `verdict` property, so the fake app-server answers
// with its ordinary plain-text task payload instead of JSON — used to
// exercise the "Codex answered, but not with JSON" path.
const NON_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string" }
  }
};

function setUpRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir) };
}

function writeSchema(dir, name, value) {
  const schemaPath = path.join(dir, name);
  fs.writeFileSync(schemaPath, JSON.stringify(value, null, 2), "utf8");
  return schemaPath;
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A predicate that reads a JSON file on disk (state.json, a job file) can
    // race a concurrent writer mid-write — a worker process or this very
    // companion rewriting it between our read and JSON.parse. Treat a parse
    // failure as "not yet", not a hard error, and let the next poll retry.
    let value;
    try {
      value = predicate();
    } catch (error) {
      if (error instanceof SyntaxError) {
        value = null;
      } else {
        throw error;
      }
    }
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForFinishedJob(scriptArgs, cwd, env, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let statusPayload = null;
  while (Date.now() < deadline) {
    const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd, env });
    assert.equal(status.status, 0, status.stderr);
    statusPayload = JSON.parse(status.stdout);
    if (statusPayload.job.status !== "queued" && statusPayload.job.status !== "running") {
      return statusPayload;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${jobId} to finish: ${JSON.stringify(statusPayload)}`);
}

test("command help documents the task --output-schema option", () => {
  const result = run("node", [SCRIPT, "--help"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task \[--background\].*\[--output-schema <path>\]/);
  // The companion only parses JSON; it does not itself validate the answer
  // against the schema — conformance is Codex's own strict-mode job.
  assert.match(result.stdout, /--output-schema forwards a JSON Schema/);
  assert.match(result.stdout, /not validated here/i);
});

test("task --output-schema forwards the parsed schema object to turn/start", () => {
  const { repo, binDir, env } = setUpRepo();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastTurnStart.outputSchema, REVIEW_FINDINGS_SCHEMA);
});

test("task --output-schema resolves a relative path against --cwd, not the invocation directory", () => {
  const { repo, binDir, env } = setUpRepo();
  const invocationDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--cwd", repo, "--output-schema", "schema.json", "run a check"], {
    cwd: invocationDir,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastTurnStart.outputSchema, REVIEW_FINDINGS_SCHEMA);
});

test("task --output-schema exposes a successfully parsed JSON answer as payload.structured", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--json", "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.structuredError, null);
  assert.deepEqual(payload.structured, APPROVE_ANSWER);
  // The raw JSON text still comes through as the ordinary task output too.
  assert.match(payload.rawOutput, /"verdict"\s*:\s*"approve"/);
});

test("task --output-schema without --json still prints Codex's raw JSON text as the task output", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"verdict":\s*"approve"/);
});

test("task --output-schema sets structured to null and records structuredError when Codex's answer is not JSON", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", NON_VERDICT_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--json", "run a check"], {
    cwd: repo,
    env
  });

  // Codex answered normally; only the schema-shaped parse failed, so the
  // command itself still exits 0.
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.structured, null);
  assert.equal(typeof payload.structuredError, "string");
  assert.notEqual(payload.structuredError, "");
  assert.match(payload.rawOutput, /Handled the requested task/);
});

test("task --output-schema surfaces the app-server's own schema rejection: failed job, structuredError with the server's text, non-empty errorMessage", () => {
  const { repo, env } = setUpRepo("schema-rejected");
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--json", "run a check"], {
    cwd: repo,
    env
  });

  // The turn itself failed (the app-server marked it "failed", not
  // "completed") — this is Codex's own strict-mode rejection, not a thrown
  // precondition error, so the command's exit status reflects that failure.
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.structured, null);
  assert.match(payload.structuredError, /did not conform to output_schema/);

  const stored = run("node", [SCRIPT, "result", "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.equal(typeof storedPayload.job.errorMessage, "string");
  assert.notEqual(storedPayload.job.errorMessage, "");
  assert.match(storedPayload.job.errorMessage, /did not conform to output_schema/);
});

test("task without --output-schema does not gain a structured/structuredError field", () => {
  const { repo, env } = setUpRepo();

  const result = run("node", [SCRIPT, "task", "--json", "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal("structured" in payload, false);
  assert.equal("structuredError" in payload, false);
});

test("task --output-schema rejects a nonexistent schema file before running Codex, and does not touch --prompt-file", () => {
  const { repo, env } = setUpRepo();
  const missingSchema = path.join(repo, "does-not-exist.json");
  const promptsDir = path.join(resolveStateDir(repo), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  // Name shaped like prompt-path's own output (<label>-<uuid>.md), so a pass
  // through consumeOneShotPromptFile's ownership check would have deleted it
  // if the schema failure did not short-circuit before that point.
  const promptFile = path.join(promptsDir, "task-11111111-1111-4111-8111-111111111111.md");
  fs.writeFileSync(promptFile, "run a check\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--output-schema", missingSchema, "--prompt-file", promptFile], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read --output-schema/);
  assert.match(result.stderr, /does-not-exist\.json/);
  // Never accepted, so the one-shot prompt file must be left in place for a retry.
  assert.equal(fs.existsSync(promptFile), true);
});

test("task --output-schema rejects malformed JSON in the schema file before running Codex", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = path.join(repo, "broken-schema.json");
  fs.writeFileSync(schemaPath, "{ not valid json", "utf8");

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "run a check"], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read --output-schema/);
});

test("task --output-schema --background carries the parsed schema into the detached worker and result --json exposes structured", async () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const launch = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--background", "--json", "run a check"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);

  const statusPayload = await waitForFinishedJob(SCRIPT, repo, env, launchPayload.jobId);
  assert.equal(statusPayload.job.status, "completed", JSON.stringify(statusPayload));

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.deepEqual(resultPayload.storedJob.result.structured, APPROVE_ANSWER);
  assert.equal(resultPayload.storedJob.result.structuredError, null);
});

test("task --output-schema --resume-last applies the schema to the resumed turn too", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const first = run("node", [SCRIPT, "task", "start a thread"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--resume-last", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.deepEqual(payload.structured, APPROVE_ANSWER);
});

test("task --background without --output-schema leaves no outputSchema key on the stored job's request", async () => {
  const { repo, env } = setUpRepo();

  const launch = run("node", [SCRIPT, "task", "--background", "--json", "run a check"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);

  await waitForFinishedJob(SCRIPT, repo, env, launchPayload.jobId);

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal("outputSchema" in resultPayload.storedJob.request, false);
  assert.equal("outputSchemaUsed" in resultPayload.storedJob, false);
});

test("task --output-schema --background strips the schema from the completed job's stored request, leaving outputSchemaUsed and the prompt intact", async () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);

  const launch = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--background", "--json", "run a check"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);

  await waitForFinishedJob(SCRIPT, repo, env, launchPayload.jobId);

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal("outputSchema" in resultPayload.storedJob.request, false);
  assert.equal(resultPayload.storedJob.outputSchemaUsed, true);
  // The prompt itself is untouched — only the schema body is stripped.
  assert.equal(resultPayload.storedJob.request.prompt, "run a check");
});

test("a task turn that fails with neither an app-server error nor stderr still gets a synthetic errorMessage", () => {
  const { repo, env } = setUpRepo("turn-fails-without-explanation");

  const result = run("node", [SCRIPT, "task", "--json", "run a check"], {
    cwd: repo,
    env
  });

  // The turn ended non-"completed" with no explanation of its own — the
  // command's exit status still reflects the failed turn, and it produced no
  // final message (errorMessage lives on the stored job, not this payload —
  // checked below via `result --json`).
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rawOutput, "");

  const stored = run("node", [SCRIPT, "result", "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.equal(typeof storedPayload.job.errorMessage, "string");
  assert.notEqual(storedPayload.job.errorMessage, "");
  assert.match(storedPayload.job.errorMessage, /Codex turn ended with status failed and no error message\./);
});

test("cancel strips --output-schema from the job file, leaving outputSchemaUsed and status cancelled", async () => {
  const { repo, env } = setUpRepo("interruptible-slow-task");
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);
  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");

  const launch = run(
    "node",
    [SCRIPT, "task", "--output-schema", schemaPath, "--background", "--json", "investigate the flaky worker timeout"],
    { cwd: repo, env }
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId ? job : null;
  });

  // Sanity check: a genuinely still-running job keeps the schema — this is
  // the baseline cancel is expected to change.
  const jobFile = path.join(stateDir, "jobs", `${jobId}.json`);
  const runningStored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(runningStored.request.outputSchema !== undefined, true);

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  const cancelledStored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(cancelledStored.status, "cancelled");
  assert.equal("outputSchema" in cancelledStored.request, false);
  assert.equal(cancelledStored.outputSchemaUsed, true);
  assert.equal(cancelledStored.request.prompt, "investigate the flaky worker timeout");
});

test("reconciling a background job whose worker died strips --output-schema from the job file", async () => {
  const { repo, env } = setUpRepo("interruptible-slow-task");
  const schemaPath = writeSchema(repo, "schema.json", REVIEW_FINDINGS_SCHEMA);
  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");

  const launch = run(
    "node",
    [SCRIPT, "task", "--output-schema", schemaPath, "--background", "--json", "investigate the flaky worker timeout"],
    { cwd: repo, env }
  );
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" ? job : null;
  });

  // Sanity check: a genuinely still-running job keeps the schema — this is
  // the baseline the dead-worker reconcile below is expected to change.
  const jobFile = path.join(stateDir, "jobs", `${jobId}.json`);
  const runningStored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(runningStored.request.outputSchema !== undefined, true);

  // Simulate the detached worker crashing mid-run: still "running" on disk,
  // but its pid is dead. reconcileRunningJobs (state.mjs) is what a later
  // listJobs() read (here, via `status`) flips this to "failed" through.
  const exitedWorker = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exitedWorker.pid;
  await new Promise((resolve, reject) => {
    exitedWorker.once("error", reject);
    exitedWorker.once("exit", resolve);
  });

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const nextState = {
    ...state,
    jobs: state.jobs.map((candidate) => (candidate.id === jobId ? { ...candidate, pid: deadPid } : candidate))
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

  const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, "failed");

  const reconciledStored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(reconciledStored.status, "failed");
  assert.equal("outputSchema" in reconciledStored.request, false);
  assert.equal(reconciledStored.outputSchemaUsed, true);
  assert.equal(reconciledStored.request.prompt, "investigate the flaky worker timeout");
});
