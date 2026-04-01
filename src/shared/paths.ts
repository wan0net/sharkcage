import { resolve } from "node:path";

/** Root install directory. Override with SHARKCAGE_DIR env var. */
export function getInstallDir(): string {
  return process.env.SHARKCAGE_DIR ?? "/opt/sharkcage";
}

/** Config directory: {installDir}/etc */
export function getConfigDir(): string {
  return process.env.SHARKCAGE_CONFIG_DIR ?? resolve(getInstallDir(), "etc");
}

/** Runtime data directory: {installDir}/var */
export function getDataDir(): string {
  return process.env.SHARKCAGE_DATA_DIR ?? resolve(getInstallDir(), "var");
}

/** Unix socket path */
export function getSocketPath(): string {
  return process.env.SHARKCAGE_SOCKET ?? resolve(getDataDir(), "supervisor.sock");
}

/** Plugins directory */
export function getPluginDir(): string {
  return process.env.SHARKCAGE_PLUGIN_DIR ?? resolve(getDataDir(), "plugins");
}

/** Approvals directory */
export function getApprovalsDir(): string {
  return resolve(getDataDir(), "approvals");
}

/** Permanent deny-list directory */
export function getDeniedDir(): string {
  return resolve(getDataDir(), "denied");
}

/** Audit log path */
export function getAuditLogPath(): string {
  return resolve(getDataDir(), "audit.jsonl");
}

/** Per-session policy directory */
export function getSessionsDir(): string {
  return resolve(getDataDir(), "sessions");
}

/** Temporary ASRT config directory */
export function getSandboxConfigDir(): string {
  return resolve(getDataDir(), "sandbox-configs");
}

/** PID file path */
export function getPidFile(): string {
  return resolve(getDataDir(), "sharkcage.pid");
}

/** Gateway config path */
export function getGatewayConfigPath(): string {
  return resolve(getConfigDir(), "gateway.json");
}

/** Install manifest path */
export function getManifestPath(): string {
  return resolve(getConfigDir(), "install.json");
}
