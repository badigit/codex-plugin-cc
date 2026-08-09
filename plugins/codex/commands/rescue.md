---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--read-only] [--cwd <dir>|-C <dir>] [--resume|--fresh] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Launch-line description:

The `Agent` tool `description` parameter is free-form text that becomes the parenthesized label on the launch line, e.g. `codex:codex-rescue(<description>)`. It is composed before the subagent selects the model, so include the resolved model and effort in it so the user can see which Codex configuration is running — especially for background runs where the companion's stderr announce is not visible.

Format the description as `<short topic> model=<model> effort=<effort>`, resolving aliases to full ids the way the companion does:

- `spark` → `gpt-5.3-codex-spark`, `sol` → `gpt-5.6-sol`, `terra` → `gpt-5.6-terra`, `luna` → `gpt-5.6-luna`. A concrete id (e.g. `gpt-5.4-mini`) passes through unchanged.
- When the user did not specify `--model`, use `model=default`. When they did not specify `--effort`, use `effort=default`.

Example: a request about "issue #144" with `--model sol --effort xhigh` → description `Codex консультация по #144 model=gpt-5.6-sol effort=xhigh`.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to `--background`. Rescue tasks are open-ended and routinely exceed Claude's Bash-tool timeout; starting in background avoids the auto-background trap (see Operating rules).
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them and `--read-only` for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--cwd <dir>` and `-C <dir>` are workspace-routing flags. Preserve the directory for the resume preflight and the forwarded `task` call, but do not treat either form as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If the request includes `--cwd <dir>` or `-C <dir>`, pass the same directory to that helper as `--cwd <dir>`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json --cwd "<dir>"
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Pass `--cwd <dir>` explicitly for the intended workspace root. Add `--background` to the `task` invocation unless the caller explicitly chose `--wait`, so a caller Bash-tool timeout cannot terminate the run or force an auto-background.
- Always pass `--label rescue`, so the run is identifiable as a rescue in the Codex app's session list instead of blending into every other delegated task.
- Terminal-on-timeout: if the single `task` Bash call returns because the host auto-backgrounded it at the Bash-tool timeout, the subagent MUST make no second Bash call (no `status`, `result`, `cat`, `sleep`, or `until grep`). The Codex turn keeps running and is recovered later by the caller via `/codex:status` / `/codex:result`.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort, in any language (including transliteration, typos, and non-Latin scripts such as Cyrillic, Thai, or Japanese). Canonical efforts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Map approximate wording to the closest canonical value using your judgment. (Examples only, not exhaustive: "ххай", "хай", "extra high", or "very high" → `xhigh`; "макс" or "maximum" → `max`.)
- Leave the model unset unless the user explicitly asks for one, in any language. Canonical model aliases: `spark` → gpt-5.3-codex-spark, `sol` → gpt-5.6-sol, `terra` → gpt-5.6-terra, `luna` → gpt-5.6-luna. If they ask for `spark`, map it to `gpt-5.3-codex-spark`. If they ask for `sol`/`terra`/`luna`, map to `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` respectively. A concrete model id (e.g. `gpt-5.4-mini`) is passed through unchanged. (Examples only, not exhaustive: a user writing "сол" or "sol" means `--model sol`.)
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
