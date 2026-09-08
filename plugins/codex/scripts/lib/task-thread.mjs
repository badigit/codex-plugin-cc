import process from "node:process";

// [dim] The thread name is what the Codex app shows in its session list, so it
// is the only handle a human has on a delegated run. Upstream named every one of
// them "Codex Companion Task", which says how the run was plumbed rather than
// what it was — a list of twenty identical rows.
//
// Two constraints shape the change:
//   1. The prefix is also the LOOKUP key (thread/list searchTerm + a startsWith
//      filter). Renaming it outright orphans every thread created before the
//      rename, so recognition has to keep matching the legacy name forever.
//   2. Recognition must stay finite, which is why labels come from a closed set
//      instead of arbitrary caller-supplied text.
const LEGACY_TASK_THREAD_PREFIX = "Codex Companion Task";

// label -> prefix used when NAMING a new thread. Keys are the closed set.
const LABEL_PREFIXES = {
  task: "Codex Task",
  review: "Codex Review",
  rescue: "Codex Rescue"
};

const DEFAULT_TASK_LABEL = "task";

export const TASK_THREAD_LABELS = Object.keys(LABEL_PREFIXES);
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

// Escape hatch, and the shape this would take as an upstream PR: one env var,
// same style as CODEX_HOME. When set it overrides naming for every label.
function envPrefix() {
  const raw = String(process.env.CODEX_TASK_THREAD_PREFIX ?? "").trim();
  return raw || null;
}

export function taskThreadPrefix(label = DEFAULT_TASK_LABEL) {
  const override = envPrefix();
  if (override) {
    return override;
  }
  const key = normalizeTaskLabel(label);
  return LABEL_PREFIXES[key];
}

export function normalizeTaskLabel(label) {
  const key = String(label ?? "").trim().toLowerCase();
  if (!key) {
    return DEFAULT_TASK_LABEL;
  }
  if (!Object.hasOwn(LABEL_PREFIXES, key)) {
    throw new Error(`Unknown thread label "${label}". Use one of: ${TASK_THREAD_LABELS.join(", ")}.`);
  }
  return key;
}

// Every prefix a thread of ours may carry: the legacy name, all label prefixes,
// and the env override if one is set. Order is irrelevant; the list only feeds
// recognition.
export function taskThreadPrefixes() {
  const prefixes = [LEGACY_TASK_THREAD_PREFIX, ...Object.values(LABEL_PREFIXES)];
  const override = envPrefix();
  if (override) {
    prefixes.push(override);
  }
  return [...new Set(prefixes)];
}

export function isTaskThreadName(name) {
  if (typeof name !== "string") {
    return false;
  }
  return taskThreadPrefixes().some((prefix) => name.startsWith(prefix));
}

// thread/list filters server-side by searchTerm, so it must match ALL of our
// names at once: the longest common prefix does that without widening the
// result set to every thread in the workspace. With the stock prefixes that is
// "Codex ". An env override that shares nothing with them collapses it to "",
// and the caller then lists unfiltered and relies on isTaskThreadName.
export function taskThreadSearchTerm() {
  const prefixes = taskThreadPrefixes();
  let common = prefixes[0] ?? "";
  for (const prefix of prefixes.slice(1)) {
    let i = 0;
    while (i < common.length && i < prefix.length && common[i] === prefix[i]) {
      i += 1;
    }
    common = common.slice(0, i);
    if (!common) {
      break;
    }
  }
  return common;
}

// [dim] Callers wrap the forwarded request in tags — `<task>…</task>` is what the
// rescue command produces. Those tags are pure plumbing, and with only 56
// characters of budget they cost a fifth of the one thing a human reads in the
// session list: "Codex Rescue: <task> Критическое ревью диапазона `git diff…".
//
// Only edge tags are stripped, repeatedly, from both ends. A blanket
// tag-stripping regex would also eat `Vec<String>` or `List<Foo>` out of the
// middle of a prompt, which is the opposite of readable.
function stripWrapperTags(text) {
  let value = String(text ?? "").trim();
  let previous;
  do {
    previous = value;
    // Снимаем только СОГЛАСОВАННУЮ пару <tag>…</tag>: имя закрывающего тега
    // обязано совпасть с открывающим. Прежняя редакция срезала любые краевые
    // теги по отдельности, и `<task>keep this</context>` превращалось в
    // `keep this` — а строка, законно начинающаяся с `<div>` или `<String>`,
    // теряла начало просто потому, что оно у края.
    const pair = value.match(/^<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/);
    if (pair) {
      value = pair[2].trim();
      continue;
    }
    // Незакрытая обёртка — ровно то, что шлёт rescue: `<task>` в начале и
    // никакого закрывающего тега, потому что промпт длиннее имени.
    const open = value.match(/^<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>([\s\S]*)$/);
    if (open && !value.includes(`</${open[1]}>`)) {
      value = open[2].trim();
    }
  } while (value !== previous);
  return value;
}

function shorten(text, limit) {
  const normalized = stripWrapperTags(text).replace(/\s+/g, " ");
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function buildPersistentTaskThreadName(prompt, label = DEFAULT_TASK_LABEL) {
  const prefix = taskThreadPrefix(label);
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${prefix}: ${excerpt}` : prefix;
}
