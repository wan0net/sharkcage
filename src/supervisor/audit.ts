import { accessSync, writeFileSync, appendFileSync } from "node:fs";
import type { AuditEntry } from "./types.js";

/**
 * Append-only audit log in JSONL format.
 * Records every tool call, whether allowed or blocked.
 */
export class AuditLog {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async open(): Promise<void> {
    // Use a simple JSONL file for now — no SQLite dependency in the supervisor.
    // The supervisor should be as dependency-light as possible.
    try {
      accessSync(this.path);
    } catch {
      writeFileSync(this.path, "");
    }
  }

  async log(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    try {
      appendFileSync(this.path, line);
    } catch (err) {
      process.stderr.write(`[audit] failed to write log entry: ${err}\n`);
    }
  }

  async logProxy(entry: {
    timestamp: string;
    skill: string;
    host: string;
    port: number;
    allowed: boolean;
    capability: string | null;
  }): Promise<void> {
    const line = JSON.stringify({ type: "proxy", ...entry }) + "\n";
    try {
      appendFileSync(this.path, line);
    } catch (err) {
      process.stderr.write(`[audit] failed to write proxy log entry: ${err}\n`);
    }
  }

  close(): void {
    // JSONL file doesn't need explicit close
  }
}
