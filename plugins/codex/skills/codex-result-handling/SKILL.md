---
name: codex-result-handling
description: Internal guidance for presenting Codex helper output back to the user
user-invocable: false
---

# Codex Result Handling

## A backgrounded run is not finished when the helper returns

`codex:codex-rescue` launches the run with `--background` and returns
immediately. Its stdout says `started in the background as <job-id>` and has a
line starting with `WAIT: ` naming the single command that collects the
answer. That text is a receipt: it is not the answer, and it is not a verdict about the answer.

- The notification that the subagent finished means the *forwarder* finished.
  The Codex turn is still running, and nothing else arrives on its own.
- Never present that receipt to the user as Codex's answer, and never read it
  as "Codex found nothing" or "Codex stayed silent". It says neither.
- Collect the answer yourself with the single `wait <job-id> ...` command
  printed in the receipt, run as its OWN background tool call (Claude Code:
  `Bash` with `run_in_background: true`) — not awaited inline, which would
  just reproduce the timeout `--background` was started to avoid. The host
  delivers exactly one notification when that call exits, and its stdout is
  already the collected answer at that point: no separate poll-then-fetch step.
- Exit code 2 means `--timeout-ms` ran out while the job was still
  queued/running — not a failure. Rerun the exact `wait <job-id> ...` command
  it prints (again as a background tool call) and do not conclude anything
  from the timeout itself.
- Only after a `wait` call returns exit code 0 or 1 do the presentation rules
  below apply.
- Tell the user the run is in flight before you start waiting, so a long Codex
  turn does not look like a hang.

When the helper returns Codex output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when the helper provides them.
- For `codex:codex-rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop.
- For `codex:codex-rescue`, if Codex was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Codex run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.
