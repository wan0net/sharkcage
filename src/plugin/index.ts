/**
 * Sharkcage OpenClaw Plugin
 *
 * Hooks into OpenClaw's native hook system to route all tool calls
 * through the sharkcage supervisor for per-skill sandboxed execution.
 *
 * Integration points (no OpenClaw fork needed):
 * - registerTool: shadow tools for each skill tool, execute routes to supervisor
 * - Hook 1: before_tool_call hook (priority 150): approval gate via native UX
 * - Hook 2: before_tool_call hook (priority 200): security scanner
 * - Hook 3: after_tool_call hook (priority 50): audit logging
 * - Hook 4: inbound_claim hook (priority 200): handles `sc install` commands
 * - Hook 5: before_message_write hook (priority 100): scrubs sharkcage internal messages
 * - registerHttpRoute: webhook for fleet dispatch results
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { SandboxViolation } from "../supervisor/types.js";
import { SupervisorClient } from "./ipc.js";
import { SkillMap } from "./skill-map.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerAsrtBackend } from "./asrt-backend.js";
import { scanSecrets, scanPII, scanCommand, isSensitiveFile, redact } from "./security-scanner.js";
import { getPluginDir, getSocketPath } from "../shared/paths.js";
import { createApprovalGateHandler, type BeforeToolCallEvent, type HookContext, type RequireApprovalResult } from "./approval-gate.js";

// --- File location (used to resolve repo root regardless of cwd) ---
const __pluginDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__pluginDir, "../..");

// --- Config ---
const pluginDir = getPluginDir();
const socketPath = getSocketPath();

// --- State ---
const supervisor = new SupervisorClient(socketPath);
const skillMap = new SkillMap();

/** Violations awaiting user approval, keyed by unique tool call ID */
const pendingViolations = new Map<string, SandboxViolation>();

// --- Violation helpers ---

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

let registered = false;

export function register(api: OpenClawPluginApi): void {
  if (registered) return;
  registered = true;
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
        // nosemgrep: typescript.react.security.react-insecure-request — localhost-only supervisor health check
        const res = await fetch("http://127.0.0.1:18790/api/status");
        return await res.text();
      } catch {
        return JSON.stringify({ error: "Supervisor not reachable" });
      }
    },
  });

  // Load skill→tool mapping
  skillMap.load(pluginDir);

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
          if (response.violation) {
            // Store the violation for the before_tool_call hook to surface to the user.
            // Use a unique ID to avoid collision between concurrent calls to the same tool.
            const violationId = randomUUID().slice(0, 8);
            pendingViolations.set(`${skillName}:${toolName}:${violationId}`, response.violation);
            return `This action requires additional permissions. Requesting approval... [sc-violation-id:${violationId}]`;
          }
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
  api.on("before_tool_call", createApprovalGateHandler({
    skillMap,
    pluginDir,
    pendingViolations,
  }), { priority: 150 });

  // --- Hook 2: before_tool_call (priority 200) — security scanning ---
  // Runs BEFORE the approval gate. Blocks dangerous commands and sensitive file access.
  api.on("before_tool_call", async (event: BeforeToolCallEvent, _ctx: HookContext) => {
    const params = event.params ?? {};
    const toolName = event.toolName;

    // Block dangerous commands in exec/bash/shell/terminal/run/computer tool calls
    const COMMAND_TOOL_NAMES = new Set(["exec", "bash", "process", "shell", "run", "terminal", "computer"]);
    if (COMMAND_TOOL_NAMES.has(toolName)) {
      const cmd = String(params.command ?? params.cmd ?? params.script ?? "");
      if (cmd) {
        const danger = scanCommand(cmd);
        if (danger) {
          console.log(`[sharkcage-security] blocked dangerous command: ${cmd.slice(0, 100)}`);
          return { block: true, blockReason: `Blocked: dangerous command pattern detected (${danger.name})` };
        }
        // Check for secrets in command args
        const secrets = scanSecrets(cmd);
        if (secrets.length > 0) {
          console.log(`[sharkcage-security] blocked secret in command: ${secrets.map(s => s.name).join(", ")}`);
          return { block: true, blockReason: `Blocked: command contains embedded secret (${secrets[0].name})` };
        }
      }
    }

    // Block access to sensitive files
    const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "file_read", "file_write", "apply_patch"]);
    if (FILE_TOOL_NAMES.has(toolName)) {
      const path = String(params.path ?? params.file_path ?? "");
      if (path && isSensitiveFile(path)) {
        console.log(`[sharkcage-security] blocked sensitive file access: ${path}`);
        return { block: true, blockReason: `Blocked: access to sensitive file (${path})` };
      }
    }

    return undefined;
  }, { priority: 200 });

  // --- Hook 3: after_tool_call (priority 50) — audit logging ---
  // Sharkcage-managed skills are audited by the supervisor directly,
  // so we only log non-sharkcage tool calls here to avoid double-counting.
  api.on("after_tool_call", async (event: AfterToolCallEvent, _ctx: HookContext) => {
    const skill = skillMap.getSkill(event.toolName);
    if (skill) return;

    console.log(`[sharkcage-audit] tool: ${event.toolName}, duration: ${event.durationMs}ms`);
  }, { priority: 50 });

  // --- Hook 4: inbound_claim (priority 200) — handle sc commands from chat ---
  // Security note: inbound_claim only fires on messages from the chat channel
  // (user-originated), NOT on AI-generated output. The AI cannot trigger skill
  // installs via this hook. The only risk is social engineering the human user
  // into typing "sc skill add <malicious-url>" — which is out of scope (same
  // threat class as "user runs malicious command in terminal").
  api.on("inbound_claim", async (event: InboundClaimEvent, _ctx: HookContext) => {
    const text = (event.content ?? "").trim();

    // sc skill add <url> — install a skill (also accept sc install for convenience)
    const installMatch = text.match(/^sc\s+(?:skill\s+add|install)\s+(.+)$/i);
    if (installMatch) {
      const source = installMatch[1].trim();
      if (!source.match(/^https:\/\/[^\s]+$/) && !source.match(/^[a-zA-Z0-9][a-zA-Z0-9@_-]*$/)) {
        console.log(`[sharkcage] rejected install source: ${source}`);
        return { handled: true };
      }
      console.log(`[sharkcage] plugin install from chat: ${source}`);
      const { execFileSync } = await import("node:child_process");
      try {
        const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
        execFileSync(process.execPath, [tsxBin, `${repoRoot}/src/cli/main.ts`, "plugin", "add", source], {
          stdio: "pipe",
          timeout: 60_000,
        });
        skillMap.load(pluginDir);
      } catch (err) {
        console.error(`[sharkcage] install failed:`, err);
      }
      return { handled: true };
    }


    return undefined;
  }, { priority: 200 });

  // --- Hook 5: before_message_write (priority 100) — scrub internals + redact secrets ---
  api.on("before_message_write", (event: BeforeMessageWriteEvent, _ctx: HookContext) => {
    const msg = event.message;
    if (!msg) return undefined;

    let content: string;
    const isArray = Array.isArray(msg.content);
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (isArray) {
      content = (msg.content as unknown[]).map((p: unknown) => typeof p === "string" ? p : (p as any)?.text ?? "").join("\n");
    } else {
      return undefined;
    }

    // Block sharkcage internal messages — use lowercase + regex to prevent case-based bypass
    const lc = content.toLowerCase();
    if (lc.includes("[sharkcage]") || /\bsc\s+yes\b/i.test(content) || /\bsc\s+no\b/i.test(content)) {
      return { block: true };
    }

    // Redact any secrets or PII from message content before it reaches the AI
    const secrets = scanSecrets(content);
    const pii = scanPII(content);
    if (secrets.length > 0 || pii.length > 0) {
      const redacted = redact(content);
      console.log(`[sharkcage-security] redacted ${secrets.length} secret(s), ${pii.length} PII from message`);
      if (isArray) {
        // Rebuild array preserving non-text parts, redacting each text part independently
        const parts = msg.content as unknown[];
        const newParts = parts.map((p: unknown) => {
          if (typeof p === "string") return redact(p);
          if (p != null && typeof (p as any).text === "string")
            return { ...(p as object), text: redact((p as any).text) };
          return p;
        });
        return { message: { ...msg, content: newParts } };
      }
      return { message: { content: redacted } };
    }

    return undefined;
  }, { priority: 100 });

  // --- Fleet webhook endpoint ---
  const FLEET_WEBHOOK_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
  api.registerHttpRoute({
    path: "/sharkcage/fleet/webhook",
    auth: "gateway",
    handler: async (req, res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > FLEET_WEBHOOK_MAX_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          return;
        }
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      console.log("[sharkcage] fleet webhook:", JSON.stringify(body).slice(0, 200));
      // TODO: route to appropriate channel for notification
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
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
  message?: { content?: string | unknown[] };
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
    handler: (event: BeforeMessageWriteEvent, ctx: HookContext) => { block: true } | { message?: { content?: string | unknown[] } } | undefined | void,
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
