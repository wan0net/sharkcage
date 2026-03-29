/**
 * Sharkcage OpenClaw Plugin
 *
 * Hooks into OpenClaw's native hook system to route all tool calls
 * through the sharkcage supervisor for per-skill sandboxed execution.
 *
 * Integration points (no OpenClaw fork needed):
 * - registerTool: shadow tools for each skill tool, execute routes to supervisor
 * - before_tool_call hook (priority 150): approval gate via native UX
 * - after_tool_call hook (priority 50): audit logging
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
 * We register hooks and shadow tools that route tool calls through the supervisor.
 */
// Plugin definition — OpenClaw reads id/name/description from the default export
export default {
  id: "sharkcage",
  name: "Sharkcage",
  description: "Trust layer — ASRT sandbox backend, per-skill capability enforcement, approval flow, audit logging.",
  register,
};

export function register(api: OpenClawPluginApi): void {
  console.log("[sharkcage] registering plugin...");

  // Register ASRT as a sandbox backend (if srt is available) — fire and forget
  registerAsrtBackend(api).catch((err) => {
    console.error("[sharkcage] ASRT backend registration failed:", err);
  });

  // Dashboard — read-only UI at /sharkcage/
  registerDashboardRoutes(api);

  // Introspect tool — lets the AI know its own capabilities
  api.registerTool({
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

  // --- Shadow tools: one per skill tool, routes execution to supervisor ---
  // The AI calls these directly. No interceptor needed for routing.
  for (const [toolName, skillName] of skillMap.getAllMappings()) {
    api.registerTool({
      name: toolName,
      description: `[sharkcage:${skillName}] Routed through sandbox`,
      parameters: { type: "object", properties: {} },
      execute: async (params: Record<string, unknown>) => {
        try {
          const response = await supervisor.call(skillName, toolName, params);
          if (response.error) return response.error;
          return response.result;
        } catch {
          return `Sandbox unavailable — supervisor unreachable. Is sharkcage running?`;
        }
      },
    });
  }

  // --- Hook 1: before_tool_call (priority 150) — approval gate ---
  // If the skill has no approval file, prompt the user natively via their channel.
  // The AI never sees this exchange.
  api.on("before_tool_call", async (event: BeforeToolCallEvent, _ctx: HookContext) => {
    const toolName = event.toolName;
    const skill = skillMap.getSkill(toolName);
    if (!skill) return undefined; // not a sharkcage-managed skill, pass through

    const approvalPath = `${configDir}/approvals/${skill}.json`;
    if (existsSync(approvalPath)) {
      // Already approved — shadow tool execute will handle routing
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
              // Also enable in OpenClaw config
              enableSkillInOpenClaw(skill);
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

  // --- Hook 2: after_tool_call (priority 50) — audit logging ---
  // Logs tool calls that went through OpenClaw natively (not sharkcage-managed).
  api.on("after_tool_call", async (event: AfterToolCallEvent, _ctx: HookContext) => {
    // Sharkcage-managed tools are already audited by the supervisor.
    // This catches OpenClaw-native tool calls (bash, read, write, edit).
    const skill = skillMap.getSkill(event.toolName);
    if (skill) return; // already audited by supervisor

    console.log(`[sharkcage-audit] tool: ${event.toolName}, duration: ${event.durationMs}ms`);
  }, { priority: 50 });

  // --- Hook 3: inbound_claim (priority 200) — handle sc commands from chat ---
  api.on("inbound_claim", async (event: InboundClaimEvent, _ctx: HookContext) => {
    const text = (event.content ?? "").trim();

    // sc install <url> — install a third-party skill
    const installMatch = text.match(/^sc\s+install\s+(.+)$/i);
    if (installMatch) {
      const source = installMatch[1].trim();
      console.log(`[sharkcage] install request from chat: ${source}`);
      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync("npx", ["tsx", `${process.cwd()}/src/cli/main.ts`, "plugin", "add", source], {
          stdio: "pipe",
          timeout: 60_000,
        });
        skillMap.load(pluginDir);
      } catch (err) {
        console.error(`[sharkcage] install failed:`, err);
      }
      return { handled: true };
    }

    // sc enable <skill> — enable a disabled bundled skill
    const enableMatch = text.match(/^sc\s+enable\s+(.+)$/i);
    if (enableMatch) {
      const skillName = enableMatch[1].trim().toLowerCase();
      console.log(`[sharkcage] enable request from chat: ${skillName}`);
      enableSkillInOpenClaw(skillName);
      console.log(`[sharkcage] skill "${skillName}" enabled`);
      return { handled: true };
    }

    // sc disable <skill> — disable a bundled skill
    const disableMatch = text.match(/^sc\s+disable\s+(.+)$/i);
    if (disableMatch) {
      const skillName = disableMatch[1].trim().toLowerCase();
      console.log(`[sharkcage] disable request from chat: ${skillName}`);
      disableSkillInOpenClaw(skillName);
      console.log(`[sharkcage] skill "${skillName}" disabled`);
      return { handled: true };
    }

    // sc skills — list skill status
    const skillsMatch = text.match(/^sc\s+skills$/i);
    if (skillsMatch) {
      // Don't consume — let the AI handle it via sharkcage_status tool
      return undefined;
    }

    return undefined;
  }, { priority: 200 });

  // --- Hook 4: before_message_write (priority 100) — scrub sharkcage internals ---
  api.on("before_message_write", (event: BeforeMessageWriteEvent, _ctx: HookContext) => {
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
    path: "/sharkcage/fleet/webhook",
    auth: "gateway",
    handler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      console.log("[sharkcage] fleet webhook:", JSON.stringify(body).slice(0, 200));
      // TODO: route to appropriate channel for notification
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    },
  });

  console.log("[sharkcage] plugin registered — tool calls will route through supervisor");
}

/**
 * Enable a skill in OpenClaw's config after sharkcage approval.
 * Adds to skills.allowBundled and tools.allow as needed.
 */
function enableSkillInOpenClaw(skillName: string): void {
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
  try {
    const config = JSON.parse(readFileSync(ocConfigPath, "utf-8"));

    // Enable the skill in entries
    if (!config.skills) config.skills = {};
    if (!config.skills.entries) config.skills.entries = {};
    config.skills.entries[skillName] = { ...(config.skills.entries[skillName] ?? {}), enabled: true };

    // If the skill needs exec (coding-agent, github, tmux, etc.), add exec to tools.allow
    const execSkills = [
      "coding-agent", "github", "gh-issues", "tmux", "gemini",
      "peekaboo", "camsnap", "video-frames", "sag", "spotify-player",
    ];
    if (execSkills.includes(skillName)) {
      if (!config.tools) config.tools = {};
      if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
      if (!config.tools.allow.includes("exec")) {
        config.tools.allow.push("exec");
      }
    }

    // If it's a messaging skill, add message tool
    const msgSkills = ["discord", "slack", "bluebubbles", "imsg", "wacli"];
    if (msgSkills.includes(skillName)) {
      if (!config.tools) config.tools = {};
      if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
      if (!config.tools.allow.includes("message")) {
        config.tools.allow.push("message");
      }
    }

    writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // Config write failed — skill will work via sharkcage but not via OpenClaw native
  }
}

/**
 * Disable a skill in OpenClaw's config.
 */
function disableSkillInOpenClaw(skillName: string): void {
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
  try {
    const config = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    if (!config.skills) config.skills = {};
    if (!config.skills.entries) config.skills.entries = {};
    config.skills.entries[skillName] = { ...(config.skills.entries[skillName] ?? {}), enabled: false };
    writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // Config write failed
  }
}

/**
 * Cleanup on shutdown.
 */
export function cleanup(): void {
  supervisor.close();
  console.log("[sharkcage] plugin cleanup complete");
}

// --- Type stubs for OpenClaw's native hook API ---

interface HookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}

interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface AfterToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  durationMs?: number;
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

interface ToolConfig {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

interface OpenClawPluginApi {
  /** Register a hook handler. */
  on(
    event: "before_tool_call",
    handler: (event: BeforeToolCallEvent, ctx: HookContext) => Promise<RequireApprovalResult | { block?: boolean; blockReason?: string; params?: Record<string, unknown>; requireApproval?: RequireApprovalResult["requireApproval"] } | undefined>,
    opts?: { priority?: number }
  ): void;
  on(
    event: "after_tool_call",
    handler: (event: AfterToolCallEvent, ctx: HookContext) => Promise<void>,
    opts?: { priority?: number }
  ): void;
  on(
    event: "inbound_claim",
    handler: (event: InboundClaimEvent, ctx: HookContext) => Promise<{ handled: true } | undefined>,
    opts?: { priority?: number }
  ): void;
  on(
    event: "before_message_write",
    handler: (event: BeforeMessageWriteEvent, ctx: HookContext) => { block: true } | { message?: BeforeMessageWriteEvent["message"] } | undefined | void,
    opts?: { priority?: number }
  ): void;

  registerTool(config: ToolConfig): void;

  registerHook(
    events: string[],
    handler: (event: Record<string, unknown>, ctx: HookContext) => Promise<unknown>,
    opts?: { priority?: number }
  ): void;

  registerHttpRoute(config: {
    path: string;
    auth: "gateway" | "plugin";
    handler: (req: any, res: any) => Promise<void>;
    match?: "exact" | "prefix";
  }): void;
}
