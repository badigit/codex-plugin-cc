# Changelog

## Unreleased

- Add `prompt-path` to `codex-companion.mjs`, printing a fresh, not-yet-existing file path under the plugin's state directory, and route the `codex-rescue` subagent's prompt delivery through `Write` + `task --prompt-file` instead of an inline Bash argument. A measured 30.6% of `codex-rescue` runs (57 of 186) failed from the prompt riding inline in the `task` command string (shell EOF, the Bash-command-length gate, a trailing backslash eating a quote); the equivalent flow via `--prompt-file` had 0 failures in 22 runs.
- `task --prompt-file <path>` deletes that one-shot file once the task it was read for is actually accepted (the background job is durably queued, or the foreground run passed every precondition and actually executed) — not immediately on read, so a run that fails a precondition (flag conflict, Codex unavailable, `--resume-last` with no prior thread) leaves the prompt file in place for a retry. Deletion additionally requires the file to be inside the prompts directory `prompt-path` handed out (verified via `fs.realpathSync` on both, not a string prefix), to be a regular file and not a symlink (`fs.lstatSync`), and to match the exact `<label>-<uuid>.md` naming `prompt-path` generates — a caller's own file, anywhere or anyhow named, is never touched. Both `prompt-path` and `task --prompt-file` also sweep prompt files older than 7 days, restricted to that same naming pattern. The prompts directory is created `0o700` on POSIX (fail-closed: an error narrowing it throws rather than silently serving prompt files from a directory of unknown permissions); on Windows, ACL inheritance is left as-is and the near-immediate deletion after read stands in for directory-level isolation instead.
- Document `--prompt-file` in `task`'s usage line (the flag already worked; it just was not discoverable).
- Stop an orphaned shared Codex app-server broker after 15 minutes with no connected clients. Active foreground and background jobs keep their broker connection open, and the timeout can be configured with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` (`0` disables the safety timer).
- Close the broker listener before asynchronous child cleanup and safely reject reconnects already queued during shutdown.
- Allow the spawned `codex app-server` handshake deadline (default 10 seconds) to be raised with `CODEX_COMPANION_SPAWNED_INITIALIZE_TIMEOUT_MS`, for cold starts and heavily loaded or CPU-limited machines, and name both the deadline and that override in the timeout error message.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
