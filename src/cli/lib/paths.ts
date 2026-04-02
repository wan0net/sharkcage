/**
 * Central path and manifest resolution for sharkcage.
 *
 * All commands import paths from here instead of hardcoding them.
 * The install manifest (etc/install.json) is written by install.sh
 * and read by every CLI command to resolve binary locations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
export {
  getInstallDir,
  getConfigDir,
  getDataDir,
  getSocketPath,
  getPidFile,
  getPluginDir,
  getApprovalsDir,
  getAuditLogPath,
  getGatewayConfigPath,
  getManifestPath,
} from "../../shared/paths.js";
import {
  getInstallDir,
  getConfigDir,
  getDataDir,
  getManifestPath,
} from "../../shared/paths.js";

export interface InstallManifest {
  installDir: string;
  nodeBin?: string;
  openclawBin: string;
  srtBin: string;
  scBin: string;
  serviceUser?: string;
  installedBy: string;
  version: string;
  installedAt: string;
}

/** Load the install manifest. Returns null if not found or invalid. */
export function loadManifest(): InstallManifest | null {
  const p = getManifestPath();
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (!data.installDir || !data.openclawBin) return null;
    return data as InstallManifest;
  } catch {
    return null;
  }
}

/**
 * Load the install manifest or exit with a clear error.
 * Use this in commands that cannot function without knowing where things are.
 */
export function requireManifest(): InstallManifest {
  const manifest = loadManifest();
  if (manifest) return manifest;

  const p = getManifestPath();
  console.error(`\ninstall.json not found at ${p}`);
  console.error("This means sharkcage hasn't been installed yet, or was moved.\n");
  console.error("To fix: re-run the installer:");
  console.error("  curl -fsSL https://raw.githubusercontent.com/wan0net/sharkcage/main/install.sh | bash\n");
  process.exit(1);
}

/** Write or update the install manifest. */
export function writeManifest(manifest: InstallManifest): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2) + "\n");
}

/** Create all required data directories. */
export function ensureDataDirs(): void {
  const dataDir = getDataDir();
  for (const sub of ["plugins", "approvals", "denied", "backups"]) {
    mkdirSync(resolve(dataDir, sub), { recursive: true });
  }
}

/** Create all required config directories. */
export function ensureConfigDir(): void {
  mkdirSync(getConfigDir(), { recursive: true });
}
