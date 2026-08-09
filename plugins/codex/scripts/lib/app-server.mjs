/**
 * @typedef {Error & { code?: string, data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadReusableBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree, windowsSpawnShell } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Error code attached to app-server request/handshake timeouts, so withAppServer
// can recognize them and fall back to a direct (non-broker) app-server. A wedged
// app-server — connect accepted but a request (initialize, ...) never answered —
// must not hang a /codex:* command forever (fork #29/#31 / upstream openai#509).
// Despite the "EBROKER" prefix the code is transport-agnostic: request() is on
// the base class and times out both the broker and the spawned transports.
export const REQUEST_TIMEOUT_CODE = "EBROKERTIMEOUT";
const BROKER_CONNECT_TIMEOUT_MS = 2000;
const BROKER_INITIALIZE_TIMEOUT_MS = 5000;

// Escape hatch for the spawned handshake deadline (fork #55). A cold start, a
// container with a tight CPU quota, or a loaded CI runner can genuinely need
// more than 10s, and until now nothing in production set the
// `spawnedInitializeTimeoutMs` option — the only caller was a test, so the
// failure was untunable. Mirrors CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS in
// app-server-broker.mjs: same env-name shape, same lenient parse, same
// fall-back-to-default-on-garbage behaviour.
export const SPAWNED_INITIALIZE_TIMEOUT_ENV = "CODEX_COMPANION_SPAWNED_INITIALIZE_TIMEOUT_MS";
export const DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS = 10000;
// Node stores a timer's delay in a 32-bit signed int; anything larger is
// silently reduced to 1ms with a TimeoutOverflowWarning. Values above this are
// unusable input, not a bigger budget.
export const MAX_SPAWNED_INITIALIZE_TIMEOUT_MS = 2147483647;

export function resolveSpawnedInitializeTimeoutMs(env = process.env) {
  const rawValue = env?.[SPAWNED_INITIALIZE_TIMEOUT_ENV];
  if (rawValue == null || rawValue === "") {
    return DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS;
  }

  // Validate *after* flooring: a positive fraction like 0.5 passes a `parsed > 0`
  // check but floors to 0, and request() only arms its timer when timeoutMs > 0.
  // That would silently disarm the handshake deadline and let a wedged spawned
  // app-server hang forever — the failure mode this deadline exists to prevent
  // (fork #29/#31). At the other end, a value above MAX_* is reduced by
  // setTimeout to 1ms, so asking for a huge budget would fail almost instantly.
  // Both extremes are unusable input: fall back to the default rather than
  // clamping, so the user sees the documented 10s behaviour instead of a
  // deadline that silently means the opposite of what they typed.
  const parsed = Math.floor(Number(rawValue));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SPAWNED_INITIALIZE_TIMEOUT_MS) {
    return DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS;
  }
  return parsed;
}

// Bound the broker socket's graceful close the same way the spawned client
// already bounds its own (close()'s 50ms killChildNow() fallback below).
// socket.end() sends FIN and waits for the peer to also close — if the peer
// stays alive and ignores it, exitPromise never resolves and close() hangs
// indefinitely. destroy()ing after a short grace period forces the "close"
// event (-> handleExit) so close() always returns, mirroring the spawned
// client's kill fallback. See #47 finding 2 (Codex review on PR #48): a
// caller's own request-level timeoutMs is not a real bound if close() itself
// can hang past it.
const BROKER_CLOSE_GRACE_MS = 50;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  // Only opt out of notifications we neither render nor need. The streaming
  // text deltas (agentMessage, reasoning summary/text) are deliberately NOT
  // opted out: captureTurn's idle deadline treats every notification as proof
  // of life, and during a long reasoning stretch these deltas are the ONLY
  // liveness signal the server emits — no item boundary arrives for minutes.
  // Opting them out made the client blind to a working agent and killed the
  // turn mid-reasoning (the gpt-5.6-sol/effort=xhigh case behind #40).
  // summaryPartAdded stays opted out: it is a boundary marker, not a delta.
  optOutNotificationMethods: ["item/reasoning/summaryPartAdded"]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @param {{ timeoutMs?: number, onTimeout?: () => void, timeoutMessage?: string }} [options]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed || this.exitResolved) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const { timeoutMs, onTimeout, timeoutMessage } = options;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          // Reject and remove first; a late answer for this id is then a no-op
          // in handleLine (it checks this.pending.get(id)). unref'd so a timed-
          // out request can't pin the event loop. onTimeout (e.g. socket.destroy
          // for the broker transport) runs before reject to force-close the peer.
          if (this.pending.delete(id)) {
            try {
              onTimeout?.();
            } catch {}
            const error = /** @type {ProtocolError} */ (new Error(
              timeoutMessage ?? `codex app-server ${method} timed out.`
            ));
            error.code = REQUEST_TIMEOUT_CODE;
            reject(error);
          }
        }, timeoutMs).unref?.();
      }
      this.pending.set(id, { resolve, reject, method, timer });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: windowsSpawnShell(),
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    const initializeTimeoutMs =
      this.options.spawnedInitializeTimeoutMs ??
      resolveSpawnedInitializeTimeoutMs(this.options.env ?? process.env);

    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }, {
        timeoutMs: initializeTimeoutMs,
        // Name both the deadline that fired and the knob that raises it — the
        // bare "initialize timed out." told the user nothing actionable (#55).
        timeoutMessage:
          `codex app-server initialize timed out after ${initializeTimeoutMs}ms. ` +
          `If this machine is slow or heavily loaded, raise the deadline with ` +
          `${SPAWNED_INITIALIZE_TIMEOUT_ENV}=<milliseconds>.`
      });
    } catch (error) {
      // A handshake failure (timeout, app-server crash) must not orphan the
      // spawned child. Kill it so the caller's fallback / teardown is clean.
      this.handleExit(error);
      this.killChildNow();
      throw error;
    }
    this.notify("initialized", {});
  }

  // Best-effort synchronous kill of the spawned child. On Windows with
  // shell:true the direct child is cmd.exe, so terminateProcessTree takes the
  // whole tree (grandchild node included); elsewhere SIGTERM suffices. Shared
  // by initialize()'s handshake-failure path and close()'s deferred kill.
  killChildNow() {
    if (!(this.proc && !this.proc.killed && this.proc.exitCode === null)) {
      return;
    }
    try {
      if (process.platform === "win32") {
        terminateProcessTree(this.proc.pid);
      } else {
        this.proc.kill("SIGTERM");
      }
    } catch {
      // Best-effort cleanup — swallow to avoid crashing the host during shutdown.
    }
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => this.killChildNow(), 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    const handshakeError = (message) => {
      const error = /** @type {ProtocolError} */ (new Error(message));
      error.code = REQUEST_TIMEOUT_CODE;
      return error;
    };

    const connectTimeoutMs = this.options.brokerConnectTimeoutMs ?? BROKER_CONNECT_TIMEOUT_MS;
    const initializeTimeoutMs = this.options.brokerInitializeTimeoutMs ?? BROKER_INITIALIZE_TIMEOUT_MS;

    // Bound the connect step: a wedged broker may accept the socket but never
    // signal connect — destroy and reject so the caller can fall back.
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      const connectTimer = setTimeout(() => {
        this.socket.destroy();
        reject(handshakeError("codex app-server broker connect timed out."));
      }, connectTimeoutMs).unref?.();
      this.socket.on("connect", () => {
        clearTimeout(connectTimer);
        resolve();
      });
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        clearTimeout(connectTimer);
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        clearTimeout(connectTimer);
        this.handleExit(this.exitError);
      });
    });

    // Bound the initialize request: a wedged broker may connect but never
    // answer. On timeout, destroy the socket so the connection does not linger
    // (onTimeout) and reject with a handshake-timeout error code.
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    }, {
      timeoutMs: initializeTimeoutMs,
      // Destroying the socket fires the close handler → handleExit, which
      // rejects any other pending requests and resolves exitPromise so a
      // wedged broker connection does not linger after the handshake fails.
      onTimeout: () => this.socket?.destroy()
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
      setTimeout(() => {
        if (!this.exitResolved) {
          this.socket?.destroy();
        }
      }, BROKER_CLOSE_GRACE_MS).unref?.();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    const brokerOptions = {
      env: options.env,
      allowBusyStaleBroker: options.allowBusyStaleBroker
    };
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = (await loadReusableBrokerSession(cwd, brokerOptions))?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, brokerOptions);
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // The handshake rejects before `connect()` returns, so callers like
      // withAppServer cannot read `client.transport` (client is never assigned
      // there). Tag the error with the transport so the caller can still tell
      // a broker-handshake failure (worth a direct fallback) from a spawned one.
      // For the broker transport every initialization failure is transport-fatal
      // (timeout, ENOENT, ECONNREFUSED — the broker socket is unusable), so mark
      // it once here and let withAppServer match on a single predicate.
      if (error && !error.transport) {
        error.transport = client.transport;
        if (client.transport === "broker") {
          error.brokerFatal = true;
        }
      }
      throw error;
    }
    return client;
  }
}
