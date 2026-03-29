/**
 * sharkcage config <subcommand>
 *
 * Subcommands:
 *   show                 Show current gateway sandbox config
 *   add-service <name>   Add a service host to outer sandbox allowlist
 *   remove-service <name> Remove a service host
 *   regenerate           Regenerate from OpenClaw config
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const sandboxConfigPath = `${configDir}/gateway-sandbox.json`;
const auditPath = `${configDir}/data/config-audit.jsonl`;

export default async function config() {
  const sub = process.argv[3];

  switch (sub) {
    case "show":
      configShow();
      break;
    case "add-service":
      await configAddService();
      break;
    case "remove-service":
      await configRemoveService();
      break;
    case "regenerate":
      await configRegenerate();
      break;
    default:
      console.log(`Usage:
  sc config show                  Show gateway sandbox config
  sc config add-service <host>    Add host to outer sandbox allowlist
  sc config remove-service <host> Remove host from allowlist
  sc config regenerate            Regenerate from OpenClaw channel config`);
  }
}

function configShow(): void {
  if (!existsSync(sandboxConfigPath)) {
    console.log("No gateway sandbox config. Run 'sc start' to generate.");
    return;
  }

  const config = JSON.parse(readFileSync(sandboxConfigPath, "utf-8"));

  console.log("Gateway sandbox config:\n");
  console.log("  Network allowlist:");
  for (const domain of config.network?.allowedDomains ?? []) {
    console.log(`    ${domain}`);
  }

  console.log("\n  Filesystem write:");
  for (const path of config.filesystem?.allowWrite ?? []) {
    console.log(`    ${path}`);
  }

  console.log("\n  Filesystem deny read:");
  for (const path of config.filesystem?.denyRead ?? []) {
    console.log(`    ${path}`);
  }

  console.log(`\n  Generated: ${config.generatedAt ?? "unknown"}`);
  console.log(`  Path: ${sandboxConfigPath}`);
}

async function configAddService(): Promise<void> {
  const host = process.argv[4];
  if (!host) {
    console.error("Usage: sc config add-service <host>");
    console.error("Example: sc config add-service api.telegram.org");
    process.exit(1);
  }

  if (!existsSync(sandboxConfigPath)) {
    console.error("No gateway sandbox config. Run 'sc start' first.");
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(sandboxConfigPath, "utf-8"));
  const domains: string[] = config.network?.allowedDomains ?? [];

  if (domains.includes(host)) {
    console.log(`"${host}" is already in the allowlist.`);
    return;
  }

  console.log(`Adding "${host}" to gateway network allowlist.`);
  console.log("This means the OpenClaw process can reach this host.\n");

  const answer = await ask("Confirm? [Y/n] ");
  if (answer.toLowerCase() === "n") {
    console.log("Cancelled.");
    return;
  }

  domains.push(host);
  config.network.allowedDomains = domains;
  config.modifiedAt = new Date().toISOString();

  writeFileSync(sandboxConfigPath, JSON.stringify(config, null, 2) + "\n");
  logConfigChange("add-service", { host });

  console.log(`Added. Restart sharkcage for changes to take effect.`);
}

async function configRemoveService(): Promise<void> {
  const host = process.argv[4];
  if (!host) {
    console.error("Usage: sc config remove-service <host>");
    process.exit(1);
  }

  if (!existsSync(sandboxConfigPath)) {
    console.error("No gateway sandbox config.");
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(sandboxConfigPath, "utf-8"));
  const domains: string[] = config.network?.allowedDomains ?? [];
  const idx = domains.indexOf(host);

  if (idx === -1) {
    console.log(`"${host}" is not in the allowlist.`);
    return;
  }

  console.log(`Removing "${host}" from gateway network allowlist.`);
  console.log("OpenClaw will no longer be able to reach this host.\n");

  const answer = await ask("Confirm? [Y/n] ");
  if (answer.toLowerCase() === "n") {
    console.log("Cancelled.");
    return;
  }

  domains.splice(idx, 1);
  config.network.allowedDomains = domains;
  config.modifiedAt = new Date().toISOString();

  writeFileSync(sandboxConfigPath, JSON.stringify(config, null, 2) + "\n");
  logConfigChange("remove-service", { host });

  console.log(`Removed. Restart sharkcage for changes to take effect.`);
}

async function configRegenerate(): Promise<void> {
  console.log("Regenerating gateway sandbox config from OpenClaw channel config...\n");

  console.log("Run 'sc stop && sc start' to regenerate from current OpenClaw config.");
}

function logConfigChange(action: string, details: Record<string, string>): void {
  const entry = {
    ts: new Date().toISOString(),
    action,
    ...details,
  };
  const line = JSON.stringify(entry) + "\n";
  try {
    appendFileSync(auditPath, line);
  } catch { /* audit dir may not exist */ }
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
