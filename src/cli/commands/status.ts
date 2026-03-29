/**
 * sharkcage status — reads PID file, checks if processes are alive, prints status summary.
 */

import { readFileSync, existsSync } from "node:fs";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = `${configDir}/data`;
const pidFile = `${dataDir}/sharkcage.pid`;
const socketPath = `${dataDir}/supervisor.sock`;
const gatewayConfigPath = `${configDir}/gateway.json`;
const auditLogPath = `${dataDir}/audit.jsonl`;

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
  console.log("\nsharkcage status\n");

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
