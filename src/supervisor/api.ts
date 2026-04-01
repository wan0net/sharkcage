/**
 * Dashboard HTTP API.
 *
 * Runs alongside the unix socket IPC server.
 * Provides read-only access to audit log, skills, approvals, and status.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalStore } from "./approvals.js";
import { getAuditEntries, getAuditStats } from "./audit-reader.js";
import { getApprovalsDir, getAuditLogPath } from "../shared/paths.js";
import type { AuditHealth } from "./audit.js";

/** Only allow simple alphanumeric skill/approval names — no path components. */
function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

let activeCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "http://127.0.0.1:18789",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface DashboardApiDeps {
  configDir: string;
  pluginDir: string;
  approvalsDir: string;
  auditPath: string;
  hasAsrt: boolean;
  auditHealth?: AuditHealth | (() => AuditHealth);
}

interface DashboardApiResult {
  status: number;
  body: unknown;
}

export function handleDashboardApiRequest(
  method: string,
  requestUrl: string,
  deps: DashboardApiDeps
): DashboardApiResult {
  const url = new URL(requestUrl, "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/api/status") {
    const skills = listSkills(deps.pluginDir, deps.approvalsDir);
    const auditHealth = typeof deps.auditHealth === "function" ? deps.auditHealth() : deps.auditHealth;
    return {
      status: 200,
      body: {
        status: "running",
        asrt: deps.hasAsrt,
        supervisorPid: process.pid,
        skills: skills.length,
        approvedSkills: skills.filter((s) => s.approved).length,
        uptime: process.uptime(),
        audit: auditHealth ?? { healthy: true, lastWriteError: null, lastWriteAt: null },
      },
    };
  }

  if (method === "GET" && path === "/api/skills") {
    return { status: 200, body: listSkills(deps.pluginDir, deps.approvalsDir) };
  }

  if (method === "GET" && path.startsWith("/api/skills/")) {
    const name = path.slice("/api/skills/".length);
    if (!isValidName(name)) return { status: 400, body: { error: "Invalid skill name" } };

    const skill = getSkillDetail(name, deps.pluginDir, deps.approvalsDir);
    if (!skill) return { status: 404, body: { error: "Skill not found" } };

    return { status: 200, body: skill };
  }

  if (method === "GET" && path === "/api/audit") {
    const tail = parseInt(url.searchParams.get("tail") ?? "100", 10);
    const skill = url.searchParams.get("skill");
    const blocked = url.searchParams.get("blocked") === "true";
    return {
      status: 200,
      body: getAuditEntries(deps.auditPath, tail, skill, blocked),
    };
  }

  if (method === "GET" && path === "/api/audit/stats") {
    return { status: 200, body: getAuditStats(deps.auditPath) };
  }

  if (method === "GET" && path === "/api/config") {
    return { status: 200, body: { configDir: deps.configDir } };
  }

  return { status: 404, body: { error: "Not found" } };
}

export function startDashboardApi(
  port: number,
  configDir: string,
  dataDir: string,
  pluginDir: string,
  approvals: ApprovalStore,
  hasAsrt: boolean,
  auditHealth: AuditHealth | (() => AuditHealth) | undefined,
  gatewayOrigin = "http://127.0.0.1:18789",
): Server {
  activeCorsHeaders = {
    "Access-Control-Allow-Origin": gatewayOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  void approvals;
  void dataDir;
  const auditPath = getAuditLogPath();
  const approvalsDir = getApprovalsDir();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, activeCorsHeaders);
      res.end();
      return;
    }

    try {
      const result = handleDashboardApiRequest(req.method ?? "GET", req.url ?? "/", {
        configDir,
        pluginDir,
        approvalsDir,
        auditPath,
        hasAsrt,
        auditHealth,
      });
      respond(res, result.status, result.body);
    } catch (err) {
      respond(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  server.on("error", (err) => {
    console.error(`dashboard API failed to start: ${err}`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`dashboard API listening on http://127.0.0.1:${port}`);
  });

  return server;
}

// --- Helpers ---

interface SkillInfo {
  name: string;
  version: string;
  description: string;
  capabilities: number;
  approved: boolean;
  approvedAt?: string;
}

export function listSkills(pluginDir: string, approvalsDir: string): SkillInfo[] {
  if (!existsSync(pluginDir)) return [];

  const skills: SkillInfo[] = [];
  for (const name of readdirSync(pluginDir)) {
    const fullPath = join(pluginDir, name);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch { continue; }

    const manifestPath = join(fullPath, "plugin.json");
    let version = "?";
    let description = "";
    let capCount = 0;

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        version = manifest.version ?? "?";
        description = manifest.description ?? "";
        capCount = manifest.capabilities?.length ?? 0;
      } catch { /* bad manifest */ }
    }

    const approvalPath = join(approvalsDir, `${name}.json`);
    let approved = false;
    let approvedAt: string | undefined;
    if (existsSync(approvalPath)) {
      try {
        const approval = JSON.parse(readFileSync(approvalPath, "utf-8"));
        approved = true;
        approvedAt = approval.approvedAt;
      } catch { /* bad approval */ }
    }

    skills.push({ name, version, description, capabilities: capCount, approved, approvedAt });
  }

  return skills;
}

export function getSkillDetail(name: string, pluginDir: string, approvalsDir: string): Record<string, unknown> | null {
  const skillDir = join(pluginDir, name);
  if (!existsSync(skillDir)) return null;

  const manifest = safeReadJson(join(skillDir, "plugin.json")) ?? {};
  const approval = safeReadJson(join(approvalsDir, `${name}.json`));

  return {
    name,
    manifest,
    approval,
  };
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...activeCorsHeaders });
  res.end(JSON.stringify(body));
}
