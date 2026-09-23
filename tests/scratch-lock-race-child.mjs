// Helper process for the cross-process contention test in
// scratch-sandbox.test.mjs. A single Node process cannot genuinely race two
// concurrent `acquireScratchSandboxLock` calls against each other: the
// function's whole winning path is synchronous (no `await` between the
// EEXIST check and a successful reclaim), so two calls made back-to-back in
// the SAME process just run one after the other, never truly interleaved —
// a naive, non-atomic takeover would look correct there even though it is
// not. Only two independent OS processes give the atomic-rename takeover
// (code-review finding IMPORTANT #3, second round) something real to guard
// against.
//
// Usage: node scratch-lock-race-child.mjs <repo> <jobId> <markerFile> <holdMs> <readyFile> <goFile>
// Writes <readyFile> once loaded, then busy-polls for <goFile> to appear
// (both racing children do this, so the test can release them within ~1ms of
// each other instead of at the mercy of process-spawn jitter) before
// attempting to acquire the scratch sandbox lock for <repo>. Once acquired,
// writes <markerFile>, holds for <holdMs>, deletes the marker, releases, and
// prints "acquired" to stdout right after acquiring (before the marker
// write).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { acquireScratchSandboxLock } = await import(
  pathToFileURL(path.join(here, "..", "plugins", "codex", "scripts", "lib", "state.mjs"))
);

const [, , repo, jobId, markerFile, holdMsRaw, readyFile, goFile] = process.argv;
const holdMs = Number(holdMsRaw) || 300;

fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(goFile)) {
  // Tight busy-wait, not setTimeout: minimizes the gap between the two
  // racing children's acquire attempts once the test drops the go file.
}

const release = await acquireScratchSandboxLock(repo, jobId, { timeoutMs: 8000, pollIntervalMs: 50 });
process.stdout.write("acquired\n");
fs.writeFileSync(markerFile, jobId);
await new Promise((resolve) => setTimeout(resolve, holdMs));
try {
  fs.unlinkSync(markerFile);
} catch {
  // best-effort
}
release();
