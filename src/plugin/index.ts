/**
 * Sharkcage OpenClaw Plugin
 *
 * Hooks into OpenClaw's native hook system to route all tool calls
 * through the sharkcage supervisor for per-skill sandboxed execution.
 *
 * Integration points (no OpenClaw fork needed):
 * - before_tool_call hook (priority 150): approval gate via native UX
 * - tool.before interceptor (priority 100): routes approved calls to supervisor
 * - tool.after interceptor (priority 50): audit logging
 * - inbound_claim hook (priority 200): handles `sc install` commands
 * - before_message_write hook (priority 100): scrubs sharkcage internal messages
 * - registerHttpRoute: webhook for fleet dispatch results
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SupervisorClient } from "./ipc.js";
import { SkillMap } from "./skill-map.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerAsrtBackend } from "./asrt-backend.js";

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
 * We register hooks and interceptors that route tool calls through the supervisor.
 */
export function register(api: OpenClawPluginApi): void {
  console.log("[sharkcage] registering plugin...");

  // Register ASRT as a sandbox backend (if srt is available)
  registerAsrtBackend(api);

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

  // --- Hook 1: before_tool_call (priority 150) — approval gate ---
  // Runs before the tool.before interceptor. If the skill has no approval file,
  // prompt the user natively via their channel. The AI never sees this exchange.
  api.on("before_tool_call", async (event: BeforeToolCallEvent) => {
    const toolName = event.toolName;
    const skill = skillMap.getSkill(toolName);
    if (!skill) return undefined; // not a sharkcage-managed skill, pass through

    const approvalPath = `${configDir}/approvals/${skill}.json`;
    if (existsSync(approvalPath)) {
      // Already approved — let the tool.before interceptor handle routing
      return undefined;
    }

    // Not yet approved — gather metadata and require approval via native channel UX
    const manifestPath = `${pluginDir}/${skill}/plugin.json`;
    let capabilities: Array<{ capability: string; reason: string; scope?: string[] }> = [];
    let version = "unknown";
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      capabilities = manifest.capabilities ?? [];
      version = manifest.version ?? "unknown";
    } catch { /* manifest unavailable */ }

    const capDescription = capabilities.length > 0
      ? capabilities.map((c) => `• ${c.capability} — ${c.reason}`).join("\n")
      : "No capabilities declared";

    return {
      requireApproval: {
        title: `Skill "${skill}" requires approval`,
        description: `${capDescription}\n\nVersion: ${version}`,
        severity: "warning" as const,
        timeoutMs: 240_000, // 4 minutes
        timeoutBehavior: "deny" as const,
        onResolution: async (decision: string) => {
          if (decision === "approved" || decision === "allow") {
            const approval = {
              skill,
              version,
              capabilities: capabilities.map((c) => c.capability),
              approvedAt: new Date().toISOString(),
              approvedVia: "channel",
            };
            try {
              writeFileSync(approvalPath, JSON.stringify(approval, null, 2) + "\n");
              console.log(`[sharkcage] approval granted for ${skill} via channel`);
            } catch (err) {
              console.error(`[sharkcage] failed to write approval file for ${skill}:`, err);
            }
          } else {
            console.log(`[sharkcage] approval denied for ${skill}`);
          }
        },
      },
    };
  }, { priority: 150 });

  // --- Hook 2: tool.before interceptor (priority 100) — route to supervisor ---
  // FAIL CLOSED: if the supervisor is unreachable, block ALL tool calls.
  // The supervisor IS the security layer. Without it, there are no
  // capability checks and no sandbox enforcement.
  api.registerInterceptor({
    name: "sharkcage-sandbox",
    priority: 100,
    event: "tool.before",
    handler: async (input: Record<string, unknown>) => {
      const toolName = (input.toolCall as Record<string, unknown> | undefined)?.name as string ?? input.name as string;
      const args = (input.toolCall as Record<string, unknown> | undefined)?.args as Record<string, unknown> ?? input.args as Record<string, unknown> ?? {};

      // Which skill owns this tool?
      const skill = skillMap.getSkill(toolName);

      if (!skill) {
        // Not a sharkcage-managed skill — let OpenClaw handle it natively
        return undefined;
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

  // --- Hook 3: tool.after interceptor (priority 50) — audit logging ---
  // Logs tool calls that went through OpenClaw natively (not sharkcage-managed).
  api.registerInterceptor({
    name: "sharkcage-audit",
    priority: 50,
    event: "tool.after",
    handler: async (input: Record<string, unknown>) => {
      // Sharkcage-managed tools are already audited by the supervisor.
      // This catches OpenClaw-native tool calls (bash, read, write, edit).
      const toolName = (input.toolCall as Record<string, unknown> | undefined)?.name as string ?? input.name as string;
      const skill = skillMap.getSkill(toolName);
      if (skill) return undefined; // already audited by supervisor

      console.log(`[sharkcage-audit] native tool: ${toolName}`);
      return undefined;
    },
  });

  // --- Hook 4: inbound_claim (priority 200) — handle `sc install` commands ---
  api.on("inbound_claim", async (event: InboundClaimEvent) => {
    const text = (event.content ?? "").trim();
    const installMatch = text.match(/^sc\s+install\s+(.+)$/i);
    if (!installMatch) return undefined;

    const source = installMatch[1].trim();
    console.log(`[sharkcage] install request from chat: ${source}`);

    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["tsx", `${process.cwd()}/src/cli/main.ts`, "plugin", "add", source], {
        stdio: "pipe",
        timeout: 60_000,
      });
      // Reload skill map to pick up new tools
      skillMap.load(pluginDir);
    } catch (err) {
      console.error(`[sharkcage] install failed:`, err);
    }

    return { handled: true }; // consume message, AI never sees it
  }, { priority: 200 });

  // --- Hook 5: before_message_write (priority 100) — scrub sharkcage internals ---
  api.on("before_message_write", async (event: BeforeMessageWriteEvent) => {
    const content = typeof event.message?.content === "string" ? event.message.content : "";
    if (
      content.includes("[sharkcage]") ||
      content.includes("sc yes ") ||
      content.includes("sc no ")
    ) {
      return { block: true };
    }
    return undefined;
  }, { priority: 100 });

  // --- Fleet webhook endpoint ---
  api.registerHttpRoute({
    method: "POST",
    path: "/sharkcage/fleet/webhook",
    handler: async (req: Request) => {
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

// --- Type stubs for OpenClaw's native hook API ---

interface BeforeToolCallEvent {
  toolName: string;
  args?: Record<string, unknown>;
}

interface InboundClaimEvent {
  content?: string;
}

interface BeforeMessageWriteEvent {
  message?: { content?: string };
}

interface RequireApprovalResult {
  requireApproval: {
    title: string;
    description: string;
    severity: "info" | "warning" | "error";
    timeoutMs: number;
    timeoutBehavior: "deny" | "allow";
    onResolution: (decision: string) => Promise<void>;
  };
}

interface OpenClawPluginApi {
  /** Register a hook handler. */
  on(
    event: "before_tool_call",
    handler: (event: BeforeToolCallEvent) => Promise<RequireApprovalResult | undefined>,
    opts?: { priority?: number }
  ): void;
  on(
    event: "inbound_claim",
    handler: (event: InboundClaimEvent) => Promise<{ handled: true } | undefined>,
    opts?: { priority?: number }
  ): void;
  on(
    event: "before_message_write",
    handler: (event: BeforeMessageWriteEvent) => Promise<{ block: true } | undefined>,
    opts?: { priority?: number }
  ): void;

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
