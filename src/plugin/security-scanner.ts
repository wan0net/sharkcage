/**
 * Security scanner — loads patterns from security-patterns.json
 * and provides scan/redact functions for the plugin hooks.
 *
 * All patterns in one auditable JSON file. This module just applies them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Patterns {
  secrets: Record<string, string>;
  pii: Record<string, string>;
  dangerous_commands: string[];
  sensitive_files: string[];
  exfiltration_domains: string[];
  c2_patterns: string[];
}

// Load patterns once at module init
const patterns: Patterns = JSON.parse(
  readFileSync(join(__dirname, "security-patterns.json"), "utf-8")
);

// Compile regexes once
const secretRegexes = Object.entries(patterns.secrets).map(
  ([name, pattern]) => ({ name, re: new RegExp(pattern, "g") })
);
const piiRegexes = Object.entries(patterns.pii).map(
  ([name, pattern]) => ({ name, re: new RegExp(pattern, "g") })
);
const dangerousCommandRegexes = patterns.dangerous_commands.map(
  (pattern) => new RegExp(pattern, "i")
);
const sensitiveFileRegexes = patterns.sensitive_files.map(
  (pattern) => new RegExp(pattern, "i")
);
const exfilDomains = new Set(patterns.exfiltration_domains);
const c2Domains = new Set(patterns.c2_patterns);

// --- Public API ---

export interface ScanResult {
  found: boolean;
  type: "secret" | "pii" | "dangerous_command" | "sensitive_file" | "exfiltration" | "c2";
  name: string;
  match?: string;
}

/** Scan text for secrets. Returns all matches. */
export function scanSecrets(text: string): ScanResult[] {
  const results: ScanResult[] = [];
  for (const { name, re } of secretRegexes) {
    re.lastIndex = 0;
    if (re.test(text)) {
      results.push({ found: true, type: "secret", name });
    }
  }
  return results;
}

/** Scan text for PII. Returns all matches. */
export function scanPII(text: string): ScanResult[] {
  const results: ScanResult[] = [];
  for (const { name, re } of piiRegexes) {
    re.lastIndex = 0;
    if (re.test(text)) {
      results.push({ found: true, type: "pii", name });
    }
  }
  return results;
}

/** Check if a command string contains dangerous patterns. */
export function scanCommand(cmd: string): ScanResult | null {
  for (const re of dangerousCommandRegexes) {
    if (re.test(cmd)) {
      return { found: true, type: "dangerous_command", name: re.source, match: cmd };
    }
  }
  return null;
}

/** Check if a file path is sensitive. */
export function isSensitiveFile(path: string): boolean {
  return sensitiveFileRegexes.some((re) => re.test(path));
}

/** Check if a domain is a known exfiltration endpoint. */
export function isExfiltrationDomain(domain: string): boolean {
  return exfilDomains.has(domain) || c2Domains.has(domain);
}

/** Redact secrets and PII from text. Returns redacted text. */
export function redact(text: string): string {
  let result = text;
  for (const { re } of secretRegexes) {
    re.lastIndex = 0;
    result = result.replace(re, "[REDACTED]");
  }
  for (const { re } of piiRegexes) {
    re.lastIndex = 0;
    result = result.replace(re, "[PII_REDACTED]");
  }
  return result;
}
