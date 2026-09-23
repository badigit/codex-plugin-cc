import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

// Shaped like scripts/delegate/schemas/review-findings.json in the tooling
// workshop: a `verdict` property is what the fake app-server keys off to
// decide it should hand back structured JSON instead of plain task text (see
// fake-codex-fixture.mjs's turn/start handler).
const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array" }
  }
};

// Deliberately lacks a `verdict` property, so the fake app-server answers
// with its ordinary plain-text task payload instead of JSON — used to
// exercise the "Codex answered, but not with JSON" path.
const NON_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string" }
  }
};

function setUpRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
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

test("command help documents the task --output-schema option", () => {
  const result = run("node", [SCRIPT, "--help"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task \[--background\].*\[--output-schema <path>\]/);
});

test("task --output-schema forwards the parsed schema object to turn/start", () => {
  const { repo, binDir, env } = setUpRepo();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const schemaPath = writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastTurnStart.outputSchema, FINDINGS_SCHEMA);
});

test("task --output-schema resolves a relative path against --cwd, not the invocation directory", () => {
  const { repo, binDir, env } = setUpRepo();
  const invocationDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--cwd", repo, "--output-schema", "schema.json", "run a check"], {
    cwd: invocationDir,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastTurnStart.outputSchema, FINDINGS_SCHEMA);
});

test("task --output-schema exposes a successfully parsed JSON answer as payload.structured", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

  const result = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--json", "run a check"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.structuredError, null);
  assert.deepEqual(payload.structured, {
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
  // The raw JSON text still comes through as the ordinary task output too.
  assert.match(payload.rawOutput, /"verdict"\s*:\s*"approve"/);
});

test("task --output-schema without --json still prints Codex's raw JSON text as the task output", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

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
  const schemaPath = writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

  const launch = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--background", "--json", "run a check"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const launchPayload = JSON.parse(launch.stdout);

  const deadline = Date.now() + 15000;
  let statusPayload = null;
  while (Date.now() < deadline) {
    const status = run("node", [SCRIPT, "status", launchPayload.jobId, "--json"], { cwd: repo, env });
    assert.equal(status.status, 0, status.stderr);
    statusPayload = JSON.parse(status.stdout);
    if (statusPayload.job.status !== "queued" && statusPayload.job.status !== "running") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(statusPayload.job.status, "completed", JSON.stringify(statusPayload));

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.deepEqual(resultPayload.storedJob.result.structured, {
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
  assert.equal(resultPayload.storedJob.result.structuredError, null);
});

test("task --output-schema --resume-last applies the schema to the resumed turn too", () => {
  const { repo, env } = setUpRepo();
  const schemaPath = writeSchema(repo, "schema.json", FINDINGS_SCHEMA);

  const first = run("node", [SCRIPT, "task", "start a thread"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--output-schema", schemaPath, "--resume-last", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.deepEqual(payload.structured, {
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
});
