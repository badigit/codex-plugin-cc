# Changelog

## Unreleased

- Add `prompt-path` to `codex-companion.mjs`, printing a fresh, not-yet-existing file path under the plugin's state directory (with a 7-day sweep of old ones), and route the `codex-rescue` subagent's prompt delivery through `Write` + `task --prompt-file` instead of an inline Bash argument. A measured 30.6% of `codex-rescue` runs (57 of 186) failed from the prompt riding inline in the `task` command string (shell EOF, the Bash-command-length gate, a trailing backslash eating a quote); the equivalent flow via `--prompt-file` had 0 failures in 22 runs.
- Document `--prompt-file` in `task`'s usage line (the flag already worked; it just was not discoverable).
- Stop an orphaned shared Codex app-server broker after 15 minutes with no connected clients. Active foreground and background jobs keep their broker connection open, and the timeout can be configured with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` (`0` disables the safety timer).
- Close the broker listener before asynchronous child cleanup and safely reject reconnects already queued during shutdown.
- Allow the spawned `codex app-server` handshake deadline (default 10 seconds) to be raised with `CODEX_COMPANION_SPAWNED_INITIALIZE_TIMEOUT_MS`, for cold starts and heavily loaded or CPU-limited machines, and name both the deadline and that override in the timeout error message.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
