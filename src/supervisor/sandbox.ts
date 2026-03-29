import { writeFileSync } from "node:fs";
import type { AsrtConfig, SkillCapability } from "./types.js";

/** Paths that are ALWAYS denied regardless of capabilities */
const MANDATORY_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/sharkcage/approvals",
  "~/.config/sharkcage/gateway-sandbox.json",
  "~/.bashrc",
  "~/.zshrc",
  "~/.gitconfig",
  "~/.netrc",
  "~/.npmrc",
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
 * Write ASRT config to a temp file, return the path.
 */
export function writeAsrtConfig(skillName: string, config: AsrtConfig): string {
  const tmpDir = process.env.TMPDIR ?? "/tmp";
  const path = `${tmpDir}/sharkcage-sandbox-${skillName}.json`;
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}
