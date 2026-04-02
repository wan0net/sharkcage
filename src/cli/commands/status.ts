/**
 * sharkcage status — reads PID file, checks if processes are alive, prints status summary.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { getPidFile, getSocketPath, getDataDir, getConfigDir, getAuditLogPath, getGatewayConfigPath, getInstallDir } from "../lib/paths.ts";
import { loadManifest } from "../lib/paths.ts";

interface PidData {
  supervisor: number;
  openclaw: number;
  startedAt: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export default async function status() {
  const pidFile = getPidFile();
  const socketPath = getSocketPath();
  const gatewayConfigPath = getGatewayConfigPath();
  const auditLogPath = getAuditLogPath();

  try {
    const gwConfig = JSON.parse(readFileSync(gatewayConfigPath, "utf-8")) as { runAsUser?: string };
    const serviceUser = gwConfig.runAsUser;
    if (serviceUser && process.env.USER !== serviceUser) {
      const manifest = loadManifest();
      const scBin = manifest?.scBin ?? `${process.env.SHARKCAGE_DIR ?? "/opt/sharkcage"}/bin/sc`;
      const installDir = manifest?.installDir ?? getInstallDir();
      const result = spawn("sudo", ["-u", serviceUser, "env", `HOME=${process.env.SHARKCAGE_DIR ?? "/opt/sharkcage"}`, scBin, "status"], {
        stdio: "inherit",
        cwd: installDir,
        env: {
          ...process.env,
          HOME: installDir,
          PATH: buildRuntimePath(manifest),
        },
      });
      result.on("exit", (code) => process.exit(code ?? 1));
      return;
    }
  } catch {
    /* no config yet */
  }

  console.log("\nsharkcage status\n");

  // Check systemd service status (Linux)
  if (process.platform === "linux") {
    try {
      const svcState = execFileSync("systemctl", ["is-active", "sharkcage"], {
        encoding: "utf-8", stdio: "pipe",
      }).trim();
      console.log(`Service:     ${svcState} (systemd)`);
    } catch {
      console.log("Service:     not managed by systemd");
    }
  }

  if (!existsSync(pidFile)) {
    console.log("sharkcage is not running\n");
    return;
  }

  try {
    const pidData: PidData = JSON.parse(readFileSync(pidFile, "utf-8"));

    const supervisorRunning = isProcessRunning(pidData.supervisor);
    const openclawRunning = isProcessRunning(pidData.openclaw);

    const supervisorStatus = supervisorRunning
      ? `running (PID ${pidData.supervisor})`
      : "stopped (stale PID)";

    const openclawStatus = openclawRunning
      ? `running (PID ${pidData.openclaw})`
      : "stopped (stale PID)";

    const uptime = formatUptime(pidData.startedAt);

    console.log(`Supervisor:  ${supervisorStatus}`);
    console.log(`OpenClaw:    ${openclawStatus}`);
    console.log(`Started:     ${pidData.startedAt}`);
    console.log(`Uptime:      ${uptime}\n`);

    console.log(`Config:      ${gatewayConfigPath}`);
    console.log(`Socket:      ${socketPath}`);
    console.log(`Audit log:   ${auditLogPath}`);
    console.log(`Dashboard:   http://127.0.0.1:18790/sharkcage/\n`);
  } catch (err) {
    console.error(
      "Error reading PID file:",
      err instanceof Error ? err.message : err
    );
    console.log("sharkcage may not be running.\n");
  }
}

function buildRuntimePath(manifest: ReturnType<typeof loadManifest>): string {
  const installDir = manifest?.installDir ?? getInstallDir();
  const currentPath = process.env.PATH ?? "";
  const segments = [
    manifest?.nodeBin ? manifest.nodeBin.replace(/\/node$/, "") : `${installDir}/bin`,
    `${installDir}/node_modules/.bin`,
    currentPath,
  ].filter(Boolean);
  return Array.from(new Set(segments)).join(":");
}
