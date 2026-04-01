import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AsrtConfig, SkillCapability } from "./types.js";
import { MANDATORY_DENY_READ } from "./types.js";
import { getSandboxConfigDir } from "../shared/paths.js";

/** Hosts that must never appear in allowedDomains — SSRF / cloud-metadata targets. */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.100",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::",
  "localhost",
]);

/** IP prefixes that must never appear in allowedDomains (private / link-local ranges). */
const BLOCKED_PREFIXES = [
  "10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.",
  "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.",
  "172.31.", "192.168.", "169.254.", "127.",
];

function isDangerousHost(host: string): boolean {
  // strip port if present (handles IPv4 and IPv6 [::1]:8080)
  const h = host.toLowerCase().replace(/\]?:\d+$/, "").replace(/^\[/, "");
  if (BLOCKED_HOSTS.has(h)) return true;
  return BLOCKED_PREFIXES.some((prefix) => h.startsWith(prefix));
}

// MANDATORY_DENY_READ is imported from ./types.js — canonical list lives there.

import { CAPABILITY_RESOURCE_MAP } from "./capabilities.js";

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
    const resource = CAPABILITY_RESOURCE_MAP[cap.capability];

    // 1. Static domains from map
    if (resource?.network) {
      resource.network.forEach(d => domains.add(d));
    }

    // 2. Dynamic domains from env variables (e.g. HA_URL)
    if (resource?.networkFromEnv) {
      const rawUrl = env?.[resource.networkFromEnv];
      if (rawUrl) {
        domains.add(rawUrl.replace(/^https?:\/\//, ""));
      }
    }

    // 3. Explicitly scoped domains (network.external / internal)
    if (cap.capability === "network.external" || cap.capability === "network.internal") {
      scope.forEach((h) => domains.add(h));
    }

    // 4. File system scopes
    if (cap.capability === "system.files.write") {
      for (const p of scope) {
        if (/^\//.test(p) && !p.includes("..")) allowWrite.push(p);
      }
    }
  }

  const allowedDomains = [...domains].filter((h) => !isDangerousHost(h));

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: false,
      allowUnixSockets: [],
    },
    filesystem: {
      allowWrite,
      denyRead: [...MANDATORY_DENY_READ],
      denyWrite: [],
    },
  };
}

/**
 * Write ASRT config to a secure user-owned directory, return the path.
 * Uses a random suffix to prevent a sandboxed skill from predicting or
 * overwriting its own config file.
 */
export function writeAsrtConfig(skillName: string, config: AsrtConfig): string {
  const sandboxConfigDir = getSandboxConfigDir();
  mkdirSync(sandboxConfigDir, { recursive: true });
  const suffix = randomBytes(8).toString("hex");
  const path = `${sandboxConfigDir}/sandbox-${skillName}-${suffix}.json`;
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}
