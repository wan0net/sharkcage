/**
 * Consistent log formatting for sc start.
 * Every line: [HH:MM:SS] [component] message
 *
 * OpenClaw's own timestamps are stripped and replaced with our format.
 * Sandbox violations are detected and logged to the audit file.
 */

import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

// ANSI color codes
const COLORS: Record<string, string> = {
  supervisor: "\x1b[36m",  // cyan
  openclaw:   "\x1b[35m",  // magenta
  proxy:      "\x1b[33m",  // yellow
  plugin:     "\x1b[32m",  // green
  audit:      "\x1b[90m",  // gray
  sc:         "\x1b[34m",  // blue
  violation:  "\x1b[31m",  // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/** OpenClaw timestamp pattern, with optional ANSI color wrapping */
const ANSI_RE = /\x1b\[\d+m/g;
const OC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*[+-]\d{2}:\d{2}\s*/;

/** Patterns that indicate a sandbox violation */
const VIOLATION_PATTERNS = [
  /Operation not permitted/i,
  /EPERM/,
  /AuthorizationCreate\(\) failed/,
  /sandbox.*denied/i,
  /sandbox.*violation/i,
  /not allowed by sandbox/i,
];

const home = process.env.HOME ?? "";
const auditPath = `${home}/.config/sharkcage/data/audit.jsonl`;

/** Dedup: track last violation message per source to avoid spam */
const lastViolation = new Map<string, string>();

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${DIM}${h}:${m}:${s}${RESET}`;
}

function cleanLine(line: string): string {
  const stripped = line.replace(ANSI_RE, "");
  return stripped.replace(OC_TIMESTAMP_RE, "");
}

function formatLine(tag: string, line: string): string {
  const color = COLORS[tag] ?? "\x1b[37m";
  const cleaned = cleanLine(line);
  return `${timestamp()} ${color}[${tag}]${RESET} ${cleaned}`;
}

/** Returns true if this line should be suppressed from console (duplicate violation) */
function checkViolation(tag: string, line: string): boolean {
  const cleaned = cleanLine(line);
  for (const pattern of VIOLATION_PATTERNS) {
    if (pattern.test(cleaned)) {
      const msg = cleaned.trim();

      // Deduplicate: suppress repeated identical violations
      if (lastViolation.get(tag) === msg) return true; // suppress
      lastViolation.set(tag, msg);

      const entry = {
        type: "sandbox-violation",
        timestamp: new Date().toISOString(),
        source: tag,
        message: msg,
      };
      try {
        if (existsSync(auditPath)) {
          appendFileSync(auditPath, JSON.stringify(entry) + "\n");
        }
      } catch { /* audit dir may not exist yet */ }
      return false; // first occurrence — show it
    }
  }
  return false; // not a violation
}

export function prefixOutput(proc: ChildProcess, tag: string): void {
  const prefixStream = (stream: NodeJS.ReadableStream | null, target: NodeJS.WritableStream) => {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          if (!checkViolation(tag, line)) {
            target.write(formatLine(tag, line) + "\n");
          }
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) {
        if (!checkViolation(tag, buffer)) {
          target.write(formatLine(tag, buffer) + "\n");
        }
      }
    });
  };

  prefixStream(proc.stdout, process.stdout);
  prefixStream(proc.stderr, process.stderr);
}

/** Log a message with a colored tag prefix (for sc start's own messages) */
export function log(tag: string, msg: string): void {
  console.log(formatLine(tag, msg));
}
