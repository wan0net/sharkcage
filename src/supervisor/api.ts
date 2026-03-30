/**
 * Dashboard HTTP API.
 *
 * Runs alongside the unix socket IPC server.
 * Provides read-only access to audit log, skills, approvals, and status.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalStore } from "./approvals.js";

/** Only allow simple alphanumeric skill/approval names — no path components. */
function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

let activeCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "http://127.0.0.1:18789",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startDashboardApi(
  port: number,
  configDir: string,
  pluginDir: string,
  approvals: ApprovalStore,
  hasAsrt: boolean,
  gatewayOrigin = "http://127.0.0.1:18789",
): void {
  activeCorsHeaders = {
    "Access-Control-Allow-Origin": gatewayOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const dataDir = `${configDir}/data`;
  const auditPath = `${dataDir}/audit.jsonl`;
  const approvalsDir = `${configDir}/approvals`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, activeCorsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      // --- GET /api/status ---
      if (path === "/api/status" && req.method === "GET") {
        const skills = listSkills(pluginDir, approvalsDir);
        respond(res, 200, {
          status: "running",
          asrt: hasAsrt,
          supervisorPid: process.pid,
          skills: skills.length,
          approvedSkills: skills.filter((s) => s.approved).length,
          uptime: process.uptime(),
        });
        return;
      }

      // --- GET /api/skills ---
      if (path === "/api/skills" && req.method === "GET") {
        respond(res, 200, listSkills(pluginDir, approvalsDir));
        return;
      }

      // --- GET /api/skills/:name ---
      if (path.startsWith("/api/skills/") && req.method === "GET") {
        const name = path.slice("/api/skills/".length);
        if (!isValidName(name)) {
          respond(res, 400, { error: "Invalid skill name" });
          return;
        }
        const skill = getSkillDetail(name, pluginDir, approvalsDir);
        if (!skill) {
          respond(res, 404, { error: "Skill not found" });
          return;
        }
        respond(res, 200, skill);
        return;
      }

      // --- GET /api/audit ---
      if (path === "/api/audit" && req.method === "GET") {
        const tail = parseInt(url.searchParams.get("tail") ?? "100", 10);
        const skill = url.searchParams.get("skill");
        const blocked = url.searchParams.get("blocked") === "true";

        const entries = getAuditEntries(auditPath, tail, skill, blocked);
        respond(res, 200, entries);
        return;
      }

      // --- GET /api/audit/stats ---
      if (path === "/api/audit/stats" && req.method === "GET") {
        const stats = getAuditStats(auditPath);
        respond(res, 200, stats);
        return;
      }

      // --- GET /api/config ---
      if (path === "/api/config" && req.method === "GET") {
        // Return only non-sensitive config summary — omit full sandbox/gateway JSON
        // which can contain credentials and network topology.
        respond(res, 200, {
          configDir,
        });
        return;
      }

      respond(res, 404, { error: "Not found" });
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

function listSkills(pluginDir: string, approvalsDir: string): SkillInfo[] {
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

function getSkillDetail(name: string, pluginDir: string, approvalsDir: string): Record<string, unknown> | null {
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

interface AuditEntry {
  timestamp: string;
  skill: string;
  tool: string;
  args: string;
  result: string;
  error: string | null;
  durationMs: number;
  blocked: boolean;
  blockReason: string | null;
}

/** Strip sensitive fields from an audit entry before serving via API. */
function sanitizeAuditEntry(entry: AuditEntry): Omit<AuditEntry, "args" | "result"> {
  const { args: _args, result: _result, ...safe } = entry;
  return safe;
}

function getAuditEntries(
  auditPath: string,
  tail: number,
  skillFilter: string | null,
  blockedOnly: boolean
): Omit<AuditEntry, "args" | "result">[] {
  if (!existsSync(auditPath)) return [];

  try {
    const stat = statSync(auditPath);
    if (stat.size > 100 * 1024 * 1024) return [];
  } catch { return []; }

  const maxTail = Math.min(tail, 10000);

  const raw = readFileSync(auditPath, "utf-8");
  let entries: AuditEntry[] = [];

  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }

  if (skillFilter) entries = entries.filter((e) => e.skill === skillFilter);
  if (blockedOnly) entries = entries.filter((e) => e.blocked);

  return entries.slice(-maxTail).map(sanitizeAuditEntry);
}

function getAuditStats(auditPath: string): Record<string, unknown> {
  if (!existsSync(auditPath)) return { total: 0, blocked: 0, errors: 0, bySkill: {} };

  try {
    const stat = statSync(auditPath);
    if (stat.size > 100 * 1024 * 1024) {
      return { total: 0, blocked: 0, errors: 0, bySkill: {}, error: "Audit log too large for stats" };
    }
  } catch {
    return { total: 0, blocked: 0, errors: 0, bySkill: {} };
  }

  const raw = readFileSync(auditPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  let total = 0;
  let blocked = 0;
  let errors = 0;
  const bySkill: Record<string, { calls: number; blocked: number }> = {};

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      total++;
      if (entry.blocked) blocked++;
      if (entry.error && !entry.blocked) errors++;

      if (!bySkill[entry.skill]) bySkill[entry.skill] = { calls: 0, blocked: 0 };
      bySkill[entry.skill].calls++;
      if (entry.blocked) bySkill[entry.skill].blocked++;
    } catch { /* skip */ }
  }

  return { total, blocked, errors, ok: total - blocked - errors, bySkill };
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
