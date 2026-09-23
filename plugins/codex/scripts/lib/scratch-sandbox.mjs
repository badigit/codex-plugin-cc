// Pure helper for `task --scratch-sandbox` (see codex-companion.mjs's
// executeTaskRun). Split out of codex-companion.mjs — which unconditionally
// runs main() at import time and so cannot be imported from a unit test —
// so this fail-closed check can be exercised directly with synthetic
// thread/start responses, independent of a real (or fake) app-server.

function normalizePathForCompare(value) {
  return String(value ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Fail-closed check of the app-server's ACTUAL thread/start response against
// what --scratch-sandbox demands, called (via runAppServerTurn's
// assertThreadStartHonored hook, see lib/codex.mjs) BEFORE turn/start is
// ever sent. Codex resolving something other than what was asked for — a
// different cwd, a non-workspace-write sandbox, network access, an
// unexpected writable root — must abort the run rather than silently
// proceed with a weaker guarantee than the flag promises.
//
// `writableRoots` is deliberately NOT required to be non-empty: it is
// documented upstream as legacy ("Legacy sandbox policy retained for
// compatibility... prefer activePermissionProfile", generated
// ThreadStartResponse.sandbox) and a live probe against codex-cli 0.153.4
// confirmed it, empirically: thread/start's ack always returns
// `writableRoots: []` for a workspace-write sandbox regardless of the
// `sandbox_workspace_write.writable_roots` override actually applied and
// enforced — while the sibling fields on that SAME ack object
// (networkAccess, excludeTmpdirEnvVar, excludeSlashTmp) DO faithfully echo
// the override. Requiring a non-empty array here would make this check
// reject every real run, correct or not — so an empty array is accepted,
// and only a NON-empty array containing anything other than the scratch
// directory is treated as a violation.
export function validateScratchSandboxThreadStart(response, { scratchDir, repoRoot }) {
  const errors = [];
  const normalizedScratch = normalizePathForCompare(scratchDir);
  const normalizedRepo = normalizePathForCompare(repoRoot);
  const normalizedCwd = normalizePathForCompare(response?.cwd);

  if (normalizedCwd !== normalizedScratch) {
    errors.push(`resolved cwd "${response?.cwd}" is not the scratch directory "${scratchDir}"`);
  }

  const sandbox = response?.sandbox;
  let writableRoots = [];
  if (sandbox?.type !== "workspaceWrite") {
    errors.push(`resolved sandbox type is "${sandbox?.type ?? "unknown"}", expected "workspaceWrite"`);
  } else {
    writableRoots = Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots : [];
    for (const root of writableRoots) {
      const normalizedRoot = normalizePathForCompare(root);
      if (normalizedRoot !== normalizedScratch) {
        errors.push(`resolved writable root "${root}" is not the scratch directory`);
      }
      if (normalizedRepo === normalizedRoot || normalizedRepo.startsWith(`${normalizedRoot}/`)) {
        errors.push(`resolved writable root "${root}" contains the repository "${repoRoot}"`);
      }
    }
    if (sandbox.excludeTmpdirEnvVar !== true) {
      errors.push(`resolved sandbox excludeTmpdirEnvVar is ${sandbox.excludeTmpdirEnvVar}, expected true`);
    }
    if (sandbox.excludeSlashTmp !== true) {
      errors.push(`resolved sandbox excludeSlashTmp is ${sandbox.excludeSlashTmp}, expected true`);
    }
  }

  if (sandbox?.networkAccess !== false) {
    errors.push(`resolved sandbox network access is ${sandbox?.networkAccess}, expected false`);
  }

  if (errors.length > 0) {
    throw new Error(`--scratch-sandbox refused: the app-server did not honor the requested sandbox policy: ${errors.join("; ")}`);
  }

  return {
    type: sandbox.type,
    cwd: response.cwd,
    writableRoots,
    networkAccess: sandbox.networkAccess
  };
}
