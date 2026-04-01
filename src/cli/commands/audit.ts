/**
 * sharkcage audit [--skill <name>] [--tool <name>] [--blocked] [--tail <n>]
 *
 * Query the audit log. Shows tool calls with timestamps, skills,
 * results, and block reasons.
 */

import { readFileSync, existsSync } from "node:fs";
import { getAuditLogPath } from "../lib/paths.ts";
import { getAuditIntegritySummary } from "../../supervisor/audit-reader.ts";

const auditPath = getAuditLogPath();

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

export default async function audit() {
  if (!existsSync(auditPath)) {
    console.log("No audit log found. Run some tool calls first.");
    return;
  }

  // Parse flags
  const args = process.argv.slice(3);
  let filterSkill: string | null = null;
  let filterTool: string | null = null;
  let onlyBlocked = false;
  let tail = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--skill": filterSkill = args[++i]; break;
      case "--tool": filterTool = args[++i]; break;
      case "--blocked": onlyBlocked = true; break;
      case "--tail": tail = parseInt(args[++i], 10) || 50; break;
      case "--all": tail = Infinity; break;
      case "--help":
        console.log(`Usage: sc audit [options]

Options:
  --skill <name>   Filter by skill name
  --tool <name>    Filter by tool name
  --blocked        Show only blocked calls
  --tail <n>       Show last N entries (default: 50)
  --all            Show all entries`);
        return;
    }
  }

  // Read and parse
  const raw = readFileSync(auditPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  let entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AuditEntry | { payload?: AuditEntry };
      if ("payload" in parsed && parsed.payload) entries.push(parsed.payload);
      else entries.push(parsed as AuditEntry);
    } catch { /* skip malformed */ }
  }

  // Apply filters
  if (filterSkill) entries = entries.filter((e) => e.skill === filterSkill);
  if (filterTool) entries = entries.filter((e) => e.tool === filterTool);
  if (onlyBlocked) entries = entries.filter((e) => e.blocked);

  // Tail
  if (tail !== Infinity) entries = entries.slice(-tail);

  if (entries.length === 0) {
    console.log("No matching audit entries.");
    return;
  }

  // Display
  console.log(`Audit log: ${entries.length} entries\n`);

  for (const e of entries) {
    const time = e.timestamp.slice(11, 19); // HH:MM:SS
    const date = e.timestamp.slice(0, 10);
    const status = e.blocked ? "BLOCKED" : e.error ? "ERROR" : "OK";
    const icon = e.blocked ? "X" : e.error ? "!" : ".";
    const duration = `${e.durationMs}ms`;

    console.log(`  [${icon}] ${date} ${time}  ${e.skill}/${e.tool}  ${status}  ${duration}`);

    if (e.blocked && e.blockReason) {
      console.log(`      Reason: ${e.blockReason}`);
    }
    if (e.error) {
      console.log(`      Error: ${e.error.slice(0, 200)}`);
    }

    // Truncate args for display
    try {
      const parsed = JSON.parse(e.args);
      const keys = Object.keys(parsed);
      if (keys.length > 0) {
        console.log(`      Args: ${keys.join(", ")}`);
      }
    } catch { /* raw args */ }
  }

  // Summary
  const blocked = entries.filter((e) => e.blocked).length;
  const errors = entries.filter((e) => e.error && !e.blocked).length;
  const ok = entries.length - blocked - errors;
  const integrity = getAuditIntegritySummary(auditPath);
  console.log(`\n  Summary: ${ok} ok, ${errors} errors, ${blocked} blocked`);
  console.log(`  Integrity: ${integrity.checked - integrity.broken}/${integrity.checked} linked, ${integrity.broken} broken`);
}
