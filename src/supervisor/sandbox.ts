import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { AsrtConfig, SkillCapability } from "./types.js";
import { MANDATORY_DENY_READ } from "./types.js";

/** Resolved home directory — used instead of `~` so srt doesn't have to expand it */
const HOME = homedir();

/** Hosts that must never appear in allowedDomains — SSRF / cloud-metadata targets. */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.100",
  "127.0.0.1",
  "::1",
  "localhost",
]);

/** IP prefixes that must never appear in allowedDomains (private / link-local ranges). */
const BLOCKED_PREFIXES = [
  "10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.",
  "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.",
  "172.31.", "192.168.", "169.254.", "127.",
];

function isDangerousHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, ""); // strip port if present
  if (BLOCKED_HOSTS.has(h)) return true;
  return BLOCKED_PREFIXES.some((prefix) => h.startsWith(prefix));
}

// MANDATORY_DENY_READ is imported from ./types.js — canonical list lives there.

/**
 * Generate an ASRT config from a skill's approved capabilities.
 * Written to a temp file and passed to `srt --settings <path>`.
 */
export function buildAsrtConfig(
  capabilities: SkillCapability[],
  env?: Record<string, string>
): AsrtConfig {
  const domains = new Set<string>();
  const allowWrite: string[] = [];

  for (const cap of capabilities) {
    const scope = cap.scope ?? [];
    switch (cap.capability) {
      case "network.external":
      case "network.internal":
        scope.forEach((h) => domains.add(h));
        break;
      case "home.read":
      case "home.control":
      case "home.automation": {
        const ha = (env?.["HA_URL"] ?? "homeassistant.local:8123").replace(/^https?:\/\//, "");
        domains.add(ha);
        break;
      }
      case "data.meals": {
        const meals = (env?.["MEALS_API_URL"] ?? "localhost:8788").replace(/^https?:\/\//, "");
        domains.add(meals);
        break;
      }
      case "fleet.dispatch":
      case "fleet.read":
      case "fleet.manage": {
        const nomad = (env?.["NOMAD_ADDR"] ?? "localhost:4646").replace(/^https?:\/\//, "");
        domains.add(nomad);
        break;
      }
      case "system.files.write":
        for (const p of scope) {
          if (/^\//.test(p) && !p.includes("..")) allowWrite.push(p);
        }
        break;
    }
  }

  const allowedDomains = [...domains].filter((h) => !isDangerousHost(h));

  return {
    network: { allowedDomains, allowUnixSockets: false },
    filesystem: { allowWrite, denyRead: [...MANDATORY_DENY_READ] },
  };
}

/**
 * Write ASRT config to a secure user-owned directory, return the path.
 * Uses a random suffix to prevent a sandboxed skill from predicting or
 * overwriting its own config file.
 */
export function writeAsrtConfig(skillName: string, config: AsrtConfig): string {
  const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${HOME}/.config/sharkcage`;
  const sandboxConfigDir = `${configDir}/data/sandbox-configs`;
  mkdirSync(sandboxConfigDir, { recursive: true });
  const suffix = randomBytes(8).toString("hex");
  const path = `${sandboxConfigDir}/sandbox-${skillName}-${suffix}.json`;
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}
