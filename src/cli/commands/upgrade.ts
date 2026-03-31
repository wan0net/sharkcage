/**
 * sc upgrade
 *
 * Safely upgrade OpenClaw with rollback support.
 * 1. Show current version
 * 2. Check latest available
 * 3. Back up current config
 * 4. Upgrade
 * 5. Quick health check
 * 6. Rollback if unhealthy
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { loadManifest, writeManifest, getInstallDir, getConfigDir, getDataDir } from "../lib/paths.ts";

const ocConfigPath = `${getInstallDir()}/.openclaw/openclaw.json`;
const scConfigDir = getConfigDir();
const backupDir = `${getDataDir()}/backups`;

export default async function upgrade() {
  p.intro("sc upgrade — safe OpenClaw upgrade with rollback");

  // --- 1. Current version ---
  let currentVersion = "unknown";
  try {
    currentVersion = execFileSync("openclaw", ["--version"], {
      encoding: "utf-8", timeout: 10_000,
    }).trim();
  } catch {
    p.log.error("Could not determine current OpenClaw version.");
    process.exit(1);
  }
  p.log.info(`Current version: ${currentVersion}`);

  // --- 2. Check latest ---
  let latestVersion = "unknown";
  try {
    const raw = execFileSync("npm", ["view", "openclaw", "version"], {
      encoding: "utf-8", timeout: 15_000,
    }).trim();
    latestVersion = raw;
  } catch {
    p.log.warning("Could not check latest version from npm.");
  }

  if (latestVersion === "unknown") {
    p.log.error("Cannot determine latest version. Check your network.");
    process.exit(1);
  }

  if (currentVersion.includes(latestVersion)) {
    p.log.success(`Already on latest version (${latestVersion}).`);
    p.outro("Nothing to do.");
    return;
  }

  p.log.info(`Latest version:  ${latestVersion}`);

  // --- 3. Confirm ---
  p.note(
    `Upgrading: ${currentVersion} → ${latestVersion}\n\n` +
    "This will:\n" +
    "  1. Back up your OpenClaw + sharkcage config\n" +
    "  2. Run npm install -g openclaw@latest\n" +
    "  3. Health check the new version\n" +
    "  4. Roll back automatically if the check fails",
    "Upgrade plan"
  );

  const proceed = await p.confirm({ message: "Continue?" });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // --- 4. Backup ---
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(backupDir, timestamp);
  mkdirSync(backupPath, { recursive: true });

  // Back up openclaw config
  if (existsSync(ocConfigPath)) {
    copyFileSync(ocConfigPath, join(backupPath, "openclaw.json"));
  }

  // Back up sharkcage config
  const scGatewayConfig = `${scConfigDir}/gateway.json`;
  if (existsSync(scGatewayConfig)) {
    copyFileSync(scGatewayConfig, join(backupPath, "sharkcage-gateway.json"));
  }
  const scSandboxConfig = `${scConfigDir}/gateway-sandbox.json`;
  if (existsSync(scSandboxConfig)) {
    copyFileSync(scSandboxConfig, join(backupPath, "gateway-sandbox.json"));
  }

  // Record current version for rollback
  writeFileSync(join(backupPath, "version.txt"), currentVersion);

  p.log.success(`Backed up to ${backupPath}`);

  // --- 5. Upgrade ---
  p.log.info("Installing new version...");
  const manifest = loadManifest();
  const cwd = manifest?.installDir ?? process.cwd();
  const installResult = spawnSync("npm", ["install", "--save", `openclaw@${latestVersion}`], {
    stdio: "inherit",
    cwd,
    timeout: 120_000,
  });

  if (installResult.status !== 0) {
    p.log.error("npm install failed. Rolling back...");
    await rollback(backupPath, currentVersion);
    process.exit(1);
  }

  // --- 6. Health check ---
  p.log.info("Running health check...");
  let healthy = false;

  try {
    // Check version matches
    const newVersion = execFileSync("openclaw", ["--version"], {
      encoding: "utf-8", timeout: 10_000,
    }).trim();

    if (!newVersion.includes(latestVersion)) {
      p.log.warning(`Version mismatch: expected ${latestVersion}, got ${newVersion}`);
    } else {
      p.log.success(`Version: ${newVersion}`);
    }

    // Check config still valid
    const configCheck = spawnSync("openclaw", ["config", "get", "gateway.mode"], {
      encoding: "utf-8", timeout: 10_000, stdio: "pipe",
    });

    if (configCheck.status === 0) {
      p.log.success("Config validation: OK");
      healthy = true;
    } else {
      p.log.error("Config validation failed — new version may have schema changes.");
    }
  } catch (err) {
    p.log.error(`Health check failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!healthy) {
    p.log.warning("Health check failed. Rolling back...");
    await rollback(backupPath, currentVersion);
    p.log.success("Rolled back successfully.");
    p.outro(`Reverted to ${currentVersion}. Check release notes before retrying.`);
    process.exit(1);
  }

  // --- 7. Update install manifest ---
  if (manifest) {
    writeManifest({
      ...manifest,
      version: latestVersion,
      installedAt: new Date().toISOString(),
    });
    p.log.info("Updated install manifest.");
  }

  // --- 8. Regenerate sandbox config ---
  // Delete the old sandbox config so sc start regenerates with new domain detection
  if (existsSync(scSandboxConfig)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(scSandboxConfig);
    p.log.info("Sandbox config will regenerate on next sc start.");
  }

  p.log.success(`Upgraded: ${currentVersion} → ${latestVersion}`);
  p.note(
    "Run `sc start` to restart with the new version.\n" +
    `Rollback available at: ${backupPath}`,
    "Next steps"
  );
  p.outro("Upgrade complete.");
}

async function rollback(backupPath: string, targetVersion: string): Promise<void> {
  // Restore config
  const backedUpOcConfig = join(backupPath, "openclaw.json");
  if (existsSync(backedUpOcConfig)) {
    copyFileSync(backedUpOcConfig, ocConfigPath);
  }

  // Reinstall old version
  const m = loadManifest();
  const rollbackCwd = m?.installDir ?? process.cwd();
  spawnSync("npm", ["install", "--save", `openclaw@${targetVersion}`], {
    stdio: "inherit",
    cwd: rollbackCwd,
    timeout: 120_000,
  });
}
