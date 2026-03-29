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
import { mkdirSync, unlinkSync } from "node:fs";
import type { ToolCallRequest, ToolCallResponse } from "./types.js";
import { ApprovalStore } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { executeInSandbox, checkAsrtAvailable } from "./worker.js";
import { startDashboardApi } from "./api.js";
import { TokenRegistry } from "./token-registry.js";
import { startLocalhostProxy } from "./proxy.js";

// --- Config ---
const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = process.env.SHARKCAGE_DATA_DIR ?? `${configDir}/data`;
const pluginDir = process.env.SHARKCAGE_PLUGIN_DIR ?? `${configDir}/plugins`;
const socketPath = process.env.SHARKCAGE_SOCKET ?? `${dataDir}/supervisor.sock`;

// --- State ---
const approvals = new ApprovalStore(`${configDir}/approvals`);
const audit = new AuditLog(`${dataDir}/audit.jsonl`);
const tokenRegistry = new TokenRegistry();

// --- Env vars to pass to skills (resolved once at startup) ---
function getSkillEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = [
    "HA_URL", "HA_TOKEN",
    "MEALS_API_URL", "MEALS_API_TOKEN",
    "NOMAD_ADDR", "NOMAD_TOKEN",
    "OPENROUTER_API_KEY",
    "BRIEFING_API_URL", "BRIEFING_API_TOKEN",
  ];
  for (const key of passthrough) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

// --- Handle a tool call request ---
async function handleRequest(request: ToolCallRequest): Promise<ToolCallResponse> {
  const timestamp = new Date().toISOString();

  // Check approval — if not approved, return error.
  // Approval is handled by the OpenClaw plugin via native hooks BEFORE the
  // tool call reaches the supervisor.
  const approval = approvals.get(request.skill);
  if (!approval) {
    const errMsg = `Skill "${request.skill}" is not approved. Approve via your chat channel first.`;
    const response: ToolCallResponse = {
      id: request.id,
      result: "",
      error: errMsg,
      durationMs: 0,
    };
    await audit.log({
      timestamp,
      skill: request.skill,
      tool: request.tool,
      args: JSON.stringify(request.args),
      result: "",
      error: errMsg,
      durationMs: 0,
      blocked: true,
      blockReason: "not approved",
    });
    return response;
  }

  // Execute in sandbox
  const skillPath = `${pluginDir}/${request.skill}`;
  const env = getSkillEnv();
  const response = await executeInSandbox(request, approval, skillPath, env, tokenRegistry);

  // Audit
  await audit.log({
    timestamp,
    skill: request.skill,
    tool: request.tool,
    args: JSON.stringify(request.args),
    result: response.result.slice(0, 2000), // truncate for audit
    error: response.error ?? null,
    durationMs: response.durationMs,
    blocked: false,
    blockReason: null,
  });

  return response;
}

// --- Unix socket server ---
function startServer(): Promise<void> {
  // Remove stale socket
  try {
    unlinkSync(socketPath);
  } catch {
    // doesn't exist, fine
  }

  return new Promise((resolve, reject) => {
    const server = createServer((conn: Socket) => {
      handleConnection(conn).catch((err) =>
        console.error("[supervisor] connection error:", err)
      );
    });

    server.on("error", (err) => {
      console.error("[supervisor] server error:", err);
      reject(err);
    });

    server.listen(socketPath, () => {
      console.log(`[supervisor] listening on ${socketPath}`);
    });
  });
}

async function handleConnection(conn: Socket): Promise<void> {
  let buffer = "";

  return new Promise((resolve) => {
    conn.on("data", async (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete JSON messages (newline-delimited)
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const request = JSON.parse(line) as ToolCallRequest;
          const response = await handleRequest(request);
          conn.write(JSON.stringify(response) + "\n");
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
      console.error("[supervisor] connection error:", err);
      resolve();
    });
  });
}

// --- Boot ---
async function main(): Promise<void> {
  console.log("[supervisor] starting...");
  console.log(`[supervisor] config: ${configDir}`);
  console.log(`[supervisor] plugins: ${pluginDir}`);
  console.log(`[supervisor] socket: ${socketPath}`);

  // Check ASRT
  const hasAsrt = await checkAsrtAvailable();
  if (hasAsrt) {
    console.log("[supervisor] ASRT (srt) available — kernel sandbox enabled");
  } else {
    console.warn("[supervisor] WARNING: srt not found — running WITHOUT kernel sandbox");
    console.warn("[supervisor] Install @anthropic-ai/sandbox-runtime for full protection");
  }

  // Start SOCKS5 localhost proxy
  startLocalhostProxy(18800, tokenRegistry, audit, getSkillEnv());

  // Ensure directories
  for (const dir of [configDir, dataDir, pluginDir, `${configDir}/approvals`]) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  }

  // Load approvals
  approvals.loadAll();

  // Open audit log
  await audit.open();

  // Start IPC server
  await startServer();

  // Start dashboard API
  const apiPort = parseInt(process.env.SHARKCAGE_API_PORT ?? "18790", 10);
  startDashboardApi(apiPort, configDir, pluginDir, approvals, hasAsrt);
}

// --- Shutdown ---
function shutdown(): void {
  console.log("[supervisor] shutting down...");
  audit.close();
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[supervisor] fatal:", err);
  process.exit(1);
});
