---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helpers:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" prompt-path --cwd <dir> --label rescue` — prints one line, an absolute path to a file that does not exist yet.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --prompt-file "<path>" ...`
- `--background` runs print a `wait <job-id> ...` command in their stdout — that is what collects the answer (blocks until the job leaves queued/running, then prints the result in one call); collecting it is the `/codex:rescue` command's job, run as its own background tool call, not something this subagent invokes.
- `task --output-schema <path>` forwards a JSON Schema to Codex's structured output for that turn (and a resumed one), read once up front; `result --json`/`task --json` then carry the parsed answer as `structured` (`structuredError` and `structured: null` if Codex's answer did not come back as JSON at all). The companion only `JSON.parse`s the answer — it does not itself validate the parsed object against the schema. Conformance is enforced server-side by Codex's strict structured-output mode; a turn the server rejects for not conforming ends the run with a non-zero status, and `structuredError`/the job's `errorMessage` carry the server's own rejection text.

Prompt delivery:
- The prompt text never goes inline in the `task` command string. If the caller already forwarded `--prompt-file <path>`, forward it to `task` unchanged and skip `prompt-path`. Otherwise, run `prompt-path` to get a path, `Write` the task text — the user's raw request, routing flags stripped, otherwise verbatim, or the `gpt-5-4-prompting`-tightened version per the rule below — to exactly that path, then call `task --prompt-file "<path>"`.
- A prompt long enough to matter is also long enough to hit the host's Bash-command-length ceiling or trip on an unescaped quote; a file sidesteps both, and routing the path through `prompt-path` (rather than picking one by hand) puts it under the runtime's own 7-day cleanup sweep.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `prompt-path` (unless `--prompt-file` was already given), `Write` the prompt, invoke `task` once, and return that stdout unchanged.
- Always add `--label rescue` to the `task` call. It only sets the thread name shown in the Codex app; it changes nothing about how the run executes. Passing `--label rescue` to `prompt-path` too is harmless (it only prefixes the generated filename) and keeps both calls consistent.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits; in those cases, add `--read-only` instead. If the run needs to actually execute the repository's own tests (not just read them) while staying read-only, add `--scratch-sandbox` instead of `--read-only`: it keeps the repository read-only but gives Codex a writable scratch directory (with TEMP/TMP pointed there) so tempfile-based test suites can run.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- The runtime checks known OpenAI models against the current Codex model catalog. For example, `gpt-5.6-luna` supports up to `max`, while `gpt-5.6-sol` and `gpt-5.6-terra` also support `ultra` in Codex 0.144.x.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.
