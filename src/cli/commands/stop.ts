/**
 * sharkcage stop — reads PID file, sends SIGTERM to supervisor + OpenClaw.
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = `${configDir}/data`;
const pidFile = `${dataDir}/sharkcage.pid`;
const socketPath = `${dataDir}/supervisor.sock`;

function killProcessTree(name: string, pid: number): boolean {
  try {
    // Kill the process group (negative PID) to get all children
    process.kill(-pid, "SIGTERM");
    console.log(`  Sent SIGTERM to ${name} group (PID ${pid})`);
  } catch {
    try {
      // Fallback: kill just the process
      process.kill(pid, "SIGTERM");
      console.log(`  Sent SIGTERM to ${name} (PID ${pid})`);
    } catch {
      console.log(`  ${name} (PID ${pid}) already stopped`);
      return false;
    }
  }

  // Wait briefly, then SIGKILL if still alive
  try {
    process.kill(pid, 0); // check if alive
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`  Sent SIGKILL to ${name} (PID ${pid})`);
      } catch { /* already dead */ }
    }, 2000);
  } catch { /* already dead */ }

  return true;
}

function killByPattern(pattern: string): boolean {
  try {
    // pkill -f matches the full command line; pattern is a hardcoded constant
    execFileSync("pkill", ["-f", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killByPort(port: number): void {
  try {
    const pids = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8" }).trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        try {
          process.kill(parseInt(pid, 10), "SIGKILL");
        } catch { /* already dead */ }
      }
    }
  } catch { /* no process on port */ }
}

export default async function stop() {
  let killed = false;

  // --- 1. Try PID file first ---
  if (existsSync(pidFile)) {
    try {
      const pids = JSON.parse(readFileSync(pidFile, "utf-8"));
      console.log("Stopping sharkcage...");

      for (const [name, pid] of Object.entries({ OpenClaw: pids.openclaw, Supervisor: pids.supervisor })) {
        if (!pid || typeof pid !== "number") continue;
        killed = killProcessTree(name, pid) || killed;
      }
    } catch (err) {
      console.error("Error reading PID file:", err instanceof Error ? err.message : err);
    }
    try { unlinkSync(pidFile); } catch { /* gone */ }
  }

  // --- 2. Fallback: find and kill by process name ---
  if (!killed) {
    console.log("No PID file found. Searching for running processes...");
  }
  // Always do the fallback sweep to catch orphans
  killed = killByPattern("supervisor/main") || killed;
  killed = killByPattern("openclaw.*gateway") || killed;

  // --- 3. Clean up ports (catch any stragglers) ---
  for (const port of [18789, 18790, 18800, 18801]) {
    killByPort(port);
  }

  // --- 4. Clean up socket + PID file ---
  try { unlinkSync(pidFile); } catch { /* gone */ }
  try { unlinkSync(socketPath); } catch { /* gone */ }

  if (killed) {
    // Wait briefly for processes to exit
    await new Promise((r) => setTimeout(r, 1000));
    console.log("Stopped.");
  } else {
    console.log("Sharkcage is not running.");
  }
}
