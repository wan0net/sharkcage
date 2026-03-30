import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { AsrtConfig, SkillCapability } from "./types.js";

/** Resolved home directory — used instead of `~` so srt doesn't have to expand it */
const HOME = homedir();

/** Paths that are ALWAYS denied regardless of capabilities */
const MANDATORY_DENY_READ = [
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gnupg`,
  `${HOME}/.config/sharkcage/approvals`,
  `${HOME}/.config/sharkcage/gateway-sandbox.json`,
  `${HOME}/.bashrc`,
  `${HOME}/.zshrc`,
  `${HOME}/.gitconfig`,
  `${HOME}/.netrc`,
  `${HOME}/.npmrc`,
];

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
        allowWrite.push(...scope);
        break;
    }
  }

  return {
    network: { allowedDomains: [...domains], allowUnixSockets: false },
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
