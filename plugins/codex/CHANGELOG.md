# Changelog

## Unreleased

- Add `prompt-path` to `codex-companion.mjs`, printing a fresh, not-yet-existing file path under the plugin's state directory, and route the `codex-rescue` subagent's prompt delivery through `Write` + `task --prompt-file` instead of an inline Bash argument. A measured 30.6% of `codex-rescue` runs (57 of 186) failed from the prompt riding inline in the `task` command string (shell EOF, the Bash-command-length gate, a trailing backslash eating a quote); the equivalent flow via `--prompt-file` had 0 failures in 22 runs.
- `task --prompt-file <path>` now deletes that file immediately after reading it, but only when `<path>` is inside the prompts directory `prompt-path` handed out — a caller's own file passed via `--prompt-file` from elsewhere is left alone. Both `prompt-path` and `task --prompt-file` also sweep prompt files older than 7 days. The prompts directory is created `0o700` on POSIX (a prompt can carry whatever was pasted into a rescue request); on Windows, ACL inheritance is left as-is and the near-immediate deletion after read stands in for directory-level isolation instead.
- Document `--prompt-file` in `task`'s usage line (the flag already worked; it just was not discoverable).
- Stop an orphaned shared Codex app-server broker after 15 minutes with no connected clients. Active foreground and background jobs keep their broker connection open, and the timeout can be configured with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` (`0` disables the safety timer).
- Close the broker listener before asynchronous child cleanup and safely reject reconnects already queued during shutdown.
- Allow the spawned `codex app-server` handshake deadline (default 10 seconds) to be raised with `CODEX_COMPANION_SPAWNED_INITIALIZE_TIMEOUT_MS`, for cold starts and heavily loaded or CPU-limited machines, and name both the deadline and that override in the timeout error message.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
