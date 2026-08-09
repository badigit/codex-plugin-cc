import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPersistentTaskThreadName,
  isTaskThreadName,
  normalizeTaskLabel,
  TASK_THREAD_LABELS,
  taskThreadPrefix,
  taskThreadPrefixes,
  taskThreadSearchTerm
} from "../plugins/codex/scripts/lib/task-thread.mjs";

const ENV_KEY = "CODEX_TASK_THREAD_PREFIX";

function withEnv(value, fn) {
  const previous = process.env[ENV_KEY];
  if (value === null) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

test("an unlabelled task keeps the plain task prefix", () => {
  withEnv(null, () => {
    assert.equal(buildPersistentTaskThreadName("review the auth flow"), "Codex Task: review the auth flow");
  });
});

test("each label gets its own prefix", () => {
  withEnv(null, () => {
    assert.equal(buildPersistentTaskThreadName("check the diff", "review"), "Codex Review: check the diff");
    assert.equal(buildPersistentTaskThreadName("unstick me", "rescue"), "Codex Rescue: unstick me");
  });
});

test("a long prompt is truncated, prefix intact", () => {
  withEnv(null, () => {
    const name = buildPersistentTaskThreadName("x".repeat(200));
    assert.ok(name.startsWith("Codex Task: "));
    assert.equal(name.length, "Codex Task: ".length + 56);
    assert.ok(name.endsWith("..."));
  });
});

test("an empty prompt degrades to the bare prefix", () => {
  withEnv(null, () => {
    assert.equal(buildPersistentTaskThreadName("   "), "Codex Task");
  });
});

test("whitespace and case in a label are tolerated", () => {
  withEnv(null, () => {
    assert.equal(normalizeTaskLabel("  Review "), "review");
    assert.equal(normalizeTaskLabel(undefined), "task");
    assert.equal(normalizeTaskLabel(""), "task");
  });
});

test("an unknown label is rejected and lists the valid ones", () => {
  assert.throws(() => normalizeTaskLabel("audit"), (error) => {
    assert.match(error.message, /Unknown thread label "audit"/);
    for (const label of TASK_THREAD_LABELS) {
      assert.ok(error.message.includes(label), `expected the error to list ${label}`);
    }
    return true;
  });
});

// The load-bearing one: the prefix is also the lookup key for --resume-last, so
// threads created before the rename must stay findable forever.
test("legacy thread names are still recognized", () => {
  withEnv(null, () => {
    assert.ok(isTaskThreadName("Codex Companion Task: something from before the rename"));
    assert.ok(isTaskThreadName("Codex Companion Task"));
  });
});

test("current thread names are recognized for every label", () => {
  withEnv(null, () => {
    for (const label of TASK_THREAD_LABELS) {
      assert.ok(isTaskThreadName(buildPersistentTaskThreadName("anything", label)), `label ${label}`);
    }
  });
});

test("unrelated thread names are not claimed", () => {
  withEnv(null, () => {
    assert.equal(isTaskThreadName("Some unrelated thread"), false);
    assert.equal(isTaskThreadName(""), false);
    assert.equal(isTaskThreadName(null), false);
    assert.equal(isTaskThreadName(undefined), false);
    assert.equal(isTaskThreadName(42), false);
  });
});

test("the server-side search term matches every prefix we may have written", () => {
  withEnv(null, () => {
    const term = taskThreadSearchTerm();
    assert.ok(term.length > 0, "an empty term would list every thread in the workspace");
    for (const prefix of taskThreadPrefixes()) {
      assert.ok(prefix.startsWith(term), `${prefix} would be filtered out by searchTerm ${JSON.stringify(term)}`);
    }
  });
});

test("the env override renames new threads without orphaning old ones", () => {
  withEnv("Codex Delegated", () => {
    assert.equal(taskThreadPrefix("task"), "Codex Delegated");
    assert.equal(buildPersistentTaskThreadName("do the thing", "review"), "Codex Delegated: do the thing");
    assert.ok(isTaskThreadName("Codex Delegated: do the thing"));
    assert.ok(isTaskThreadName("Codex Companion Task: from before"), "legacy names must survive an override");
    assert.ok(isTaskThreadName("Codex Task: from the stock prefix"));
    for (const prefix of taskThreadPrefixes()) {
      assert.ok(prefix.startsWith(taskThreadSearchTerm()));
    }
  });
});

test("an override sharing nothing with the stock prefixes collapses the search term instead of dropping threads", () => {
  withEnv("Zeta", () => {
    assert.equal(taskThreadSearchTerm(), "", "no common prefix means the caller must list unfiltered");
    assert.ok(isTaskThreadName("Zeta: current"));
    assert.ok(isTaskThreadName("Codex Companion Task: legacy"));
  });
});
