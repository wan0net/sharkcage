/**
 * Central path and manifest resolution for sharkcage.
 *
 * All commands import paths from here instead of hardcoding them.
 * The install manifest (etc/install.json) is written by install.sh
 * and read by every CLI command to resolve binary locations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface InstallManifest {
  installDir: string;
  openclawBin: string;
  srtBin: string;
  scBin: string;
  serviceUser?: string;
  installedBy: string;
  version: string;
  installedAt: string;
}

/** Root install directory. Override with SHARKCAGE_DIR env var. */
export function getInstallDir(): string {
  return process.env.SHARKCAGE_DIR ?? "/opt/sharkcage";
}

/** Config directory: {installDir}/etc */
export function getConfigDir(): string {
  return resolve(getInstallDir(), "etc");
}

/** Runtime data directory: {installDir}/var */
export function getDataDir(): string {
  return resolve(getInstallDir(), "var");
}

/** Unix socket path */
export function getSocketPath(): string {
  return resolve(getDataDir(), "supervisor.sock");
}

/** PID file path */
export function getPidFile(): string {
  return resolve(getDataDir(), "sharkcage.pid");
}

/** Plugins directory */
export function getPluginDir(): string {
  return resolve(getDataDir(), "plugins");
}

/** Approvals directory */
export function getApprovalsDir(): string {
  return resolve(getDataDir(), "approvals");
}

/** Audit log path */
export function getAuditLogPath(): string {
  return resolve(getDataDir(), "audit.jsonl");
}

/** Gateway config path */
export function getGatewayConfigPath(): string {
  return resolve(getConfigDir(), "gateway.json");
}

/** Install manifest path */
export function getManifestPath(): string {
  return resolve(getConfigDir(), "install.json");
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
