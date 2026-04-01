/**
 * Sharkcage Supervisor
 *
 * The only unsandboxed process. Owns all ASRT sandboxes.
 * Receives tool call requests from OpenClaw via unix socket,
 * executes them in per-skill ASRT sandboxes, returns results.
 *
 * ~150 lines. Auditable in an afternoon.
 */

import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolCallRequest, ToolCallResponse } from "./types.js";
import { ApprovalStore } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { executeInSandbox, checkAsrtAvailable } from "./worker.js";
import { startDashboardApi } from "./api.js";
import { TokenRegistry, startLocalhostProxy } from "./proxy.js";
import { resolveSandboxStartupDecision } from "./startup.js";
import { getApprovalsDir, getAuditLogPath, getConfigDir, getDataDir, getPluginDir, getSocketPath, getDeniedDir } from "../shared/paths.js";
import { handleToolCall } from "./core.js";

// --- Config ---
const configDir = getConfigDir();
const dataDir = getDataDir();
const pluginDir = getPluginDir();
const socketPath = getSocketPath();

// --- State ---
const approvals = new ApprovalStore(getApprovalsDir());
const audit = new AuditLog(getAuditLogPath());
const tokenRegistry = new TokenRegistry();

// --- Env vars to pass to skills (resolved once at startup) ---
import { getAllServiceEnvVars } from "./capabilities.js";

function getSkillEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = getAllServiceEnvVars();
  for (const key of passthrough) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

// --- Handle a tool call request ---
async function handleRequest(request: ToolCallRequest): Promise<ToolCallResponse> {
  return handleToolCall(request, {
    approvals,
    audit,
    execute: executeInSandbox,
    pluginDir,
    getSkillEnv,
    tokenRegistry,
  });
}

// --- Unix socket server ---
function startServer(): Promise<void> {
  // Remove stale socket
  try {
    unlinkSync(socketPath);
  } catch {
    // doesn't exist, fine
  }

  // Ensure the directory containing the socket is restricted to owner-only.
  // This prevents other local users from connecting to the socket even
  // during the tiny window between listen() and chmodSync().
  try {
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true });
    chmodSync(socketDir, 0o700);
  } catch (err) {
    console.warn(`[sharkcage] failed to restrict socket directory: ${err}`);
  }

  return new Promise((resolve, reject) => {
    const server = createServer((conn: Socket) => {
      handleConnection(conn).catch((err) =>
        console.error("connection error:", err)
      );
    });

    server.on("error", (err) => {
      console.error("server error:", err);
      reject(err);
    });

    server.listen(socketPath, () => {
      // Final guard — restrict the socket itself
      try { chmodSync(socketPath, 0o600); } catch { /* best-effort */ }
      console.log(`listening on ${socketPath}`);
      resolve();
    });
  });
}

async function handleConnection(conn: Socket): Promise<void> {
  let buffer = "";

  return new Promise((resolve) => {
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete JSON messages (newline-delimited)
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const request = JSON.parse(line) as ToolCallRequest;
          handleRequest(request).then((response) => {
            conn.write(JSON.stringify(response) + "\n");
          }).catch((err) => console.error("request error:", err));
        } catch (err) {
          conn.write(JSON.stringify({
            id: "unknown",
            result: "",
            error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: 0,
          }) + "\n");
        }
      }
    });

    conn.on("end", () => {
      resolve();
    });

    conn.on("error", (err) => {
      console.error("connection error:", err);
      resolve();
    });
  });
}

// --- Boot ---
async function main(): Promise<void> {
  console.log("starting...");
  console.log(`config: ${configDir}`);
  console.log(`plugins: ${pluginDir}`);
  console.log(`socket: ${socketPath}`);

  // Check ASRT
  const hasAsrt = await checkAsrtAvailable();
  const sandboxDecision = resolveSandboxStartupDecision(hasAsrt);
  if (!sandboxDecision.allowed) {
    console.error(sandboxDecision.message);
    process.exit(1);
  }
  if (sandboxDecision.mode === "secure") {
    console.log("ASRT (srt) available — kernel sandbox enabled");
  } else {
    console.warn(`WARNING: ${sandboxDecision.message}`);
  }

  // Ensure directories
  for (const dir of [configDir, dataDir, pluginDir, getApprovalsDir(), getDeniedDir()]) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  }

  // Load approvals
  approvals.loadAll();

  // Open audit log
  await audit.open();

  // Start SOCKS5 localhost proxy
  startLocalhostProxy(18800, tokenRegistry, audit, getSkillEnv());

  // Start IPC server
  await startServer();

  // Start dashboard API
  const apiPort = parseInt(process.env.SHARKCAGE_API_PORT ?? "18790", 10);
  const gatewayPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
  startDashboardApi(apiPort, configDir, dataDir, pluginDir, approvals, sandboxDecision.mode === "secure", () => audit.getHealth(), `http://127.0.0.1:${gatewayPort}`);
}

// --- Shutdown ---
function shutdown(): void {
  console.log("shutting down...");
  audit.close();
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
