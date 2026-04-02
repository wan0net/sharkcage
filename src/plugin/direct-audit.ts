import type { AuditEntry } from "../supervisor/types.js";
import type { SupervisorClient } from "./ipc.js";

function safeStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function limit(value: string, max = 2000): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function buildDirectToolAuditEntry(event: {
  toolName: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  durationMs?: number;
  blocked?: boolean;
  blockReason?: string | null;
}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    skill: "openclaw",
    tool: event.toolName,
    args: limit(safeStringify(event.params ?? {})),
    result: limit(safeStringify(event.result)),
    error: event.error == null ? null : limit(safeStringify(event.error)),
    durationMs: event.durationMs ?? 0,
    blocked: Boolean(event.blocked),
    blockReason: event.blocked ? event.blockReason ?? "blocked by openclaw hook" : null,
    source: "openclaw-direct",
  };
}

export async function recordDirectToolAudit(
  supervisor: SupervisorClient,
  event: Parameters<typeof buildDirectToolAuditEntry>[0]
): Promise<void> {
  await supervisor.recordAudit(buildDirectToolAuditEntry(event));
}
