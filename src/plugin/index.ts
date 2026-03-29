/**
 * Sharkcage OpenClaw Plugin
 *
 * Hooks into OpenClaw's interceptor pipeline to route all tool calls
 * through the sharkcage supervisor for per-skill sandboxed execution.
 *
 * Integration points (no OpenClaw fork needed):
 * - tool.before interceptor: routes tool calls to supervisor via IPC
 * - tool.after interceptor: audit logging
 * - registerHttpRoute: webhook for fleet dispatch results
 */

import { SupervisorClient } from "./ipc.js";
import { SkillMap } from "./skill-map.js";
import { registerDashboardRoutes } from "./dashboard.js";

// --- Config ---
const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = process.env.SHARKCAGE_DATA_DIR ?? `${configDir}/data`;
const pluginDir = process.env.SHARKCAGE_PLUGIN_DIR ?? `${configDir}/plugins`;
const socketPath = process.env.SHARKCAGE_SOCKET ?? `${dataDir}/supervisor.sock`;

// --- State ---
const supervisor = new SupervisorClient(socketPath);
const skillMap = new SkillMap();

/**
 * OpenClaw plugin entry point.
 *
 * Called by OpenClaw's plugin loader with the plugin API.
 * We register interceptors that route tool calls through the supervisor.
 */
export function register(api: OpenClawPluginApi): void {
  console.log("[sharkcage] registering plugin...");

  // Dashboard — read-only UI at /sharkcage/
  registerDashboardRoutes(api);

  // Introspect tool — lets the AI know its own capabilities
  api.registerTool?.({
    name: "sharkcage_status",
    description: "Check what skills are loaded, what capabilities are approved, what's been blocked. Use when the user asks what you can do or about your permissions.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      try {
        const res = await fetch("http://127.0.0.1:18790/api/status");
        return await res.text();
      } catch {
        return JSON.stringify({ error: "Supervisor not reachable" });
      }
    },
  });

  // Load skill→tool mapping
  skillMap.load(pluginDir);

  // Connect to supervisor
  supervisor.connect().catch((err) => {
    console.error("[sharkcage] failed to connect to supervisor:", err);
    console.error("[sharkcage] is `sharkcage start` running?");
  });

  // --- tool.before interceptor ---
  // FAIL CLOSED: if the supervisor is unreachable, block ALL tool calls.
  // The supervisor IS the security layer. Without it, there are no
  // capability checks and no sandbox enforcement.
  api.registerInterceptor({
    name: "sharkcage-sandbox",
    priority: 100, // highest — runs before other interceptors
    event: "tool.before",
    handler: async (input: any) => {
      const toolName = input.toolCall?.name ?? input.name;
      const args = input.toolCall?.args ?? input.args ?? {};

      // Which skill owns this tool?
      const skill = skillMap.getSkill(toolName);

      if (!skill) {
        // Not a sharkcage-managed skill — let OpenClaw handle it natively
        // (built-in tools like bash/read/write go through OpenClaw's own sandbox)
        return undefined; // pass through
      }

      // Route to supervisor — FAIL CLOSED on any error
      try {
        const response = await supervisor.call(skill, toolName, args);

        if (response.error) {
          return {
            block: true,
            reason: response.error,
          };
        }

        // Return the result, skipping OpenClaw's in-process execution
        return {
          result: response.result,
          skipExecution: true,
        };
      } catch (err) {
        // FAIL CLOSED — supervisor unreachable means no sandbox.
        // Block the tool call entirely. Do not fall through to unsandboxed execution.
        console.error(`[sharkcage] FAIL CLOSED: supervisor unreachable for ${toolName}:`, err);
        return {
          block: true,
          reason: `Sandbox unavailable — supervisor unreachable. All tool calls blocked for safety. Is sharkcage running?`,
        };
      }
    },
  });

  // --- tool.after interceptor ---
  // Logs tool calls that went through OpenClaw natively (not sharkcage-managed).
  api.registerInterceptor({
    name: "sharkcage-audit",
    priority: 50,
    event: "tool.after",
    handler: async (input: any) => {
      // Sharkcage-managed tools are already audited by the supervisor.
      // This catches OpenClaw-native tool calls (bash, read, write, edit).
      const toolName = input.toolCall?.name ?? input.name;
      const skill = skillMap.getSkill(toolName);
      if (skill) return undefined; // already audited by supervisor

      console.log(`[sharkcage-audit] native tool: ${toolName}`);
      return undefined;
    },
  });

  // --- Fleet webhook endpoint ---
  api.registerHttpRoute({
    method: "POST",
    path: "/sharkcage/fleet/webhook",
    handler: async (req) => {
      const body = await req.json();
      console.log("[sharkcage] fleet webhook:", JSON.stringify(body).slice(0, 200));
      // TODO: route to appropriate channel for notification
      return new Response(JSON.stringify({ accepted: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log("[sharkcage] plugin registered — tool calls will route through supervisor");
}

/**
 * Cleanup on shutdown.
 */
export function cleanup(): void {
  supervisor.close();
  console.log("[sharkcage] plugin cleanup complete");
}

// --- Type stubs for OpenClaw's plugin API ---
// These match OpenClaw's actual API. In production, imported from OpenClaw's types.
interface OpenClawPluginApi {
  registerInterceptor(config: {
    name: string;
    priority: number;
    event: "tool.before" | "tool.after" | "message.before" | "params.before";
    toolMatcher?: RegExp;
    agentMatcher?: RegExp;
    handler: (input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  }): void;

  registerHttpRoute(config: {
    method: string;
    path: string;
    handler: (req: Request) => Promise<Response>;
  }): void;

  registerTool?(config: Record<string, unknown>): void;
}
