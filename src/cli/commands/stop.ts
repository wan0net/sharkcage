/**
 * sharkcage stop — reads PID file, sends SIGTERM to supervisor + OpenClaw.
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = `${configDir}/data`;
const pidFile = `${dataDir}/sharkcage.pid`;
const socketPath = `${dataDir}/supervisor.sock`;

export default async function stop() {
  if (!existsSync(pidFile)) {
    console.log("Sharkcage is not running (no PID file).");
    return;
  }

  try {
    const pids = JSON.parse(readFileSync(pidFile, "utf-8"));
    console.log("Stopping sharkcage...");

    for (const [name, pid] of Object.entries({ OpenClaw: pids.openclaw, Supervisor: pids.supervisor })) {
      if (!pid) continue;
      try {
        process.kill(pid as number, "SIGTERM");
        console.log(`  Sent SIGTERM to ${name} (PID ${pid})`);
      } catch {
        console.log(`  ${name} (PID ${pid}) already stopped`);
      }
    }

    try { unlinkSync(pidFile); } catch { /* gone */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    console.log("Stopped.");
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
  }
}
