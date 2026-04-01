import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AuditEntryRecord {
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

interface AuditEnvelope<T> {
  v?: number;
  seq?: number;
  prevHash?: string | null;
  entryHash?: string;
  recordedAt?: string;
  kind?: "tool" | "proxy";
  payload?: T;
}

export interface AuditIntegritySummary {
  checked: number;
  broken: number;
  lastSeq: number;
}

function listAuditFiles(auditPath: string): string[] {
  const dir = dirname(auditPath);
  const base = basename(auditPath);
  const archives = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(`${base}.`))
        .sort()
        .map((name) => join(dir, name))
    : [];
  return [...archives, auditPath].filter((path) => existsSync(path));
}

function toEntryRecord(line: string): AuditEntryRecord | null {
  try {
    const parsed = JSON.parse(line) as AuditEntryRecord | AuditEnvelope<AuditEntryRecord>;
    if ("payload" in parsed && parsed.payload) return parsed.payload;
    if ("skill" in parsed && "tool" in parsed) return parsed as AuditEntryRecord;
    return null;
  } catch {
    return null;
  }
}

export function getAuditIntegritySummary(auditPath: string): AuditIntegritySummary {
  const files = listAuditFiles(auditPath);
  let expectedPrevHash: string | null = null;
  let checked = 0;
  let broken = 0;
  let lastSeq = 0;

  for (const file of files) {
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) continue;
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as AuditEnvelope<unknown>;
        if (!entry.entryHash || typeof entry.seq !== "number") continue;
        checked++;
        lastSeq = Math.max(lastSeq, entry.seq);
        if (entry.prevHash !== expectedPrevHash) broken++;
        expectedPrevHash = entry.entryHash;
      } catch {
        broken++;
      }
    }
  }

  return { checked, broken, lastSeq };
}

export function sanitizeAuditEntry(entry: AuditEntryRecord): Omit<AuditEntryRecord, "args" | "result"> {
  const { args: _args, result: _result, ...safe } = entry;
  return safe;
}

export function getAuditEntries(
  auditPath: string,
  tail: number,
  skillFilter: string | null,
  blockedOnly: boolean
): Omit<AuditEntryRecord, "args" | "result">[] {
  if (!existsSync(auditPath)) return [];

  const maxTail = Math.min(tail, 10000);
  let entries: AuditEntryRecord[] = [];

  for (const file of listAuditFiles(auditPath)) {
    try {
      const stat = statSync(file);
      if (stat.size > 100 * 1024 * 1024) continue;
    } catch {
      continue;
    }

    const raw = readFileSync(file, "utf-8").trim();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const entry = toEntryRecord(line);
      if (entry) entries.push(entry);
    }
  }

  if (skillFilter) entries = entries.filter((entry) => entry.skill === skillFilter);
  if (blockedOnly) entries = entries.filter((entry) => entry.blocked);

  return entries.slice(-maxTail).map(sanitizeAuditEntry);
}

export function getAuditStats(auditPath: string): Record<string, unknown> {
  if (!existsSync(auditPath)) return { total: 0, blocked: 0, errors: 0, bySkill: {} };

  let total = 0;
  let blocked = 0;
  let errors = 0;
  const bySkill: Record<string, { calls: number; blocked: number }> = {};

  for (const file of listAuditFiles(auditPath)) {
    try {
      const stat = statSync(file);
      if (stat.size > 100 * 1024 * 1024) continue;
    } catch {
      continue;
    }

    const raw = readFileSync(file, "utf-8").trim();
    for (const line of raw.split("\n").filter(Boolean)) {
      const entry = toEntryRecord(line);
      if (!entry) continue;
      total++;
      if (entry.blocked) blocked++;
      if (entry.error && !entry.blocked) errors++;
      if (!bySkill[entry.skill]) bySkill[entry.skill] = { calls: 0, blocked: 0 };
      bySkill[entry.skill].calls++;
      if (entry.blocked) bySkill[entry.skill].blocked++;
    }
  }

  return {
    total,
    blocked,
    errors,
    ok: total - blocked - errors,
    bySkill,
    integrity: getAuditIntegritySummary(auditPath),
  };
}
