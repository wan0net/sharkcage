import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AuditEntry } from "./types.js";

interface AuditLogOptions {
  maxBytes?: number;
  maxArchives?: number;
}

interface AuditEnvelope<T> {
  v: 1;
  seq: number;
  prevHash: string | null;
  entryHash: string;
  recordedAt: string;
  kind: "tool" | "proxy";
  payload: T;
}

export interface AuditHealth {
  healthy: boolean;
  lastWriteError: string | null;
  lastWriteAt: string | null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeEntryHash(kind: "tool" | "proxy", payload: unknown, seq: number, prevHash: string | null, recordedAt: string): string {
  return createHash("sha256")
    .update(stableStringify({ kind, payload, seq, prevHash, recordedAt }))
    .digest("hex");
}

function archivePath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = `${path}.${stamp}`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.${stamp}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export class AuditLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private seq = 0;
  private lastHash: string | null = null;
  private lastWriteError: string | null = null;
  private lastWriteAt: string | null = null;

  constructor(path: string, options: AuditLogOptions = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxArchives = options.maxArchives ?? 5;
  }

  async open(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "");
      return;
    }

    const raw = readFileSync(this.path, "utf-8").trim();
    if (!raw) return;

    const lastLine = raw.split("\n").filter(Boolean).at(-1);
    if (!lastLine) return;

    try {
      const envelope = JSON.parse(lastLine) as Partial<AuditEnvelope<unknown>>;
      this.seq = typeof envelope.seq === "number" ? envelope.seq : 0;
      this.lastHash = typeof envelope.entryHash === "string" ? envelope.entryHash : null;
    } catch {
      this.lastWriteError = "Audit log contains malformed trailing entry";
    }
  }

  async log(entry: AuditEntry): Promise<void> {
    this.write("tool", entry);
  }

  async logProxy(entry: {
    timestamp: string;
    skill: string;
    host: string;
    port: number;
    allowed: boolean;
    capability: string | null;
  }): Promise<void> {
    this.write("proxy", entry);
  }

  getHealth(): AuditHealth {
    return {
      healthy: this.lastWriteError == null,
      lastWriteError: this.lastWriteError,
      lastWriteAt: this.lastWriteAt,
    };
  }

  close(): void {
    // JSONL file doesn't need explicit close
  }

  private write(kind: "tool" | "proxy", payload: unknown): void {
    const recordedAt = new Date().toISOString();
    const seq = this.seq + 1;
    const prevHash = this.lastHash;
    const entryHash = computeEntryHash(kind, payload, seq, prevHash, recordedAt);
    const line = JSON.stringify({
      v: 1,
      seq,
      prevHash,
      entryHash,
      recordedAt,
      kind,
      payload,
    } satisfies AuditEnvelope<unknown>) + "\n";

    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.path, line, { flush: true });
      this.seq = seq;
      this.lastHash = entryHash;
      this.lastWriteAt = recordedAt;
      this.lastWriteError = null;
    } catch (err) {
      this.lastWriteError = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[audit] failed to write ${kind} entry: ${this.lastWriteError}\n`);
    }
  }

  private rotateIfNeeded(nextEntryBytes: number): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size === 0 || size + nextEntryBytes <= this.maxBytes) return;

    renameSync(this.path, archivePath(this.path));
    writeFileSync(this.path, "");
    this.pruneArchives();
  }

  private pruneArchives(): void {
    const dir = dirname(this.path);
    const base = basename(this.path);
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`))
      .sort()
      .reverse();

    for (const stale of archives.slice(this.maxArchives)) {
      try {
        unlinkSync(join(dir, stale));
      } catch {
        // best effort
      }
    }
  }
}
