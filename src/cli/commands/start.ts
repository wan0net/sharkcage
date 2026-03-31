/**
 * sharkcage start
 *
 * One command to go from nothing to running:
 * 1. Check/install dependencies (OpenClaw, srt)
 * 2. Run sharkcage init if no config exists
 * 3. Register sharkcage plugin with OpenClaw
 * 4. Start the supervisor
 * 5. Start OpenClaw
 * 6. Monitor both processes, restart on failure
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { prefixOutput, log } from "../log-prefix.ts";
import { getInstallDir, getSocketPath, getPidFile, getPluginDir, getGatewayConfigPath, loadManifest, ensureDataDirs } from "../lib/paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");


export default async function start(options: { foreground?: boolean } = {}) {
  // --- 0. Re-exec as dedicated user if needed ---
  // If a dedicated user is configured and we're not already that user,
  // re-run the entire sc start command as that user via sudo.
  // This ensures supervisor, openclaw, and all file access use one user.
  try {
    const gwConfig = JSON.parse(readFileSync(getGatewayConfigPath(), "utf-8"));
    const serviceUser = gwConfig.runAsUser;
    if (serviceUser && process.env.USER !== serviceUser) {
      log("sc", `Re-executing as ${serviceUser}...`);
      const manifest = loadManifest();
      const scBin = manifest?.scBin ?? `${getInstallDir()}/bin/sc`;
      const args = ["sudo", "-u", serviceUser, scBin, "start"];
      if (options.foreground) args.push("--foreground");
      const result = spawn(args[0], args.slice(1), {
        stdio: "inherit",
        env: { ...process.env, HOME: getInstallDir() },
      });
      result.on("exit", (code) => process.exit(code ?? 1));
      return;
    }
  } catch { /* no config yet, continue normally */ }

  log("sc", "sharkcage starting");

  // --- 1. Check dependencies ---
  const deps = checkDependencies();
  log("sc", `node: ok`);
  log("sc", `openclaw: ${deps.openclaw ? "ok" : "missing"}`);
  log("sc", `srt: ${deps.srt ? "ok" : "not found (sandbox disabled)"}`);

  if (!deps.allPresent) {
    await installMissing(deps);
  }

  // --- 2. Check config ---
  if (!existsSync(getGatewayConfigPath())) {
    log("sc", "No config found — running setup wizard");
    const init = await import("./init.js");
    await init.default();
  }

  // --- 3. Ensure directories ---
  ensureDataDirs();

  // --- 4. Register sharkcage plugin with OpenClaw ---
  ensureOpenClawPluginRegistered();

  // --- 5. Check if already running ---
  if (existsSync(getPidFile())) {
    try {
      const pids = JSON.parse(readFileSync(getPidFile(), "utf-8"));
      if (isProcessRunning(pids.supervisor) || isProcessRunning(pids.openclaw)) {
        log("sc", "Already running — run 'sc stop' first");
        process.exit(1);
      }
    } catch { /* corrupt pid file */ }
    try { unlinkSync(getPidFile()); } catch { /* gone */ }
  }

  // --- 6. Start supervisor ---
  log("sc", "Starting supervisor...");
  let supervisorProc = startSupervisor(options);
  log("sc", `Supervisor PID ${supervisorProc.pid}`);

  await waitForSocket(getSocketPath(), 10_000);
  log("sc", "Supervisor ready");

  // --- 8. Start OpenClaw ---
  let runAsUser: string | undefined;
  try {
    const scConfig = JSON.parse(readFileSync(getGatewayConfigPath(), "utf-8"));
    runAsUser = scConfig.runAsUser;
  } catch { /* no config or missing field */ }

  if (runAsUser) {
    log("sc", `Running OpenClaw as user: ${runAsUser}`);
  }
  log("sc", "Starting OpenClaw...");
  const openclawProc = startOpenClaw(runAsUser, options);
  log("sc", `OpenClaw PID ${openclawProc.pid}`);

  // Determine gateway bind address for URLs
  let gatewayHost = "127.0.0.1";
  try {
    const ocConfig = JSON.parse(readFileSync(`${getInstallDir()}/.openclaw/openclaw.json`, "utf-8"));
    const bind = ocConfig.gateway?.bind;
    if (bind && bind !== "0.0.0.0") {
      gatewayHost = bind;
    } else if (bind === "0.0.0.0") {
      // Bound to all interfaces — resolve LAN IP
      try {
        // ip route is the most reliable way to get the primary LAN IP
        const route = execFileSync("ip", ["route", "get", "1.1.1.1"], { encoding: "utf-8" });
        const match = route.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        gatewayHost = match?.[1] ?? "0.0.0.0";
      } catch {
        gatewayHost = "0.0.0.0";
      }
    }
  } catch { /* use default */ }

  await waitForHttp("http://127.0.0.1:18789", 30_000);
  log("sc", "OpenClaw ready");

  // --- 9. Write PID file ---
  if (!options.foreground) {
    writeFileSync(getPidFile(), JSON.stringify({
      supervisor: supervisorProc.pid,
      openclaw: openclawProc.pid,
      startedAt: new Date().toISOString(),
    }));
  }

  // --- 10. Running ---
  log("sc", "━━━ sharkcage running ━━━");
  log("sc", `Web UI:    http://${gatewayHost}:18789/#token=${gatewayToken}`);
  log("sc", `Dashboard: http://${gatewayHost}:18789/sharkcage/?token=${gatewayToken}`);
  log("sc", `API:       http://${gatewayHost}:18790/api/status`);
  log("sc", "Press Ctrl+C to stop");

  // --- 11. Monitor + shutdown ---
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("sc", "Shutting down...");
    safeKill(openclawProc);
    safeKill(supervisorProc);
    try { unlinkSync(getPidFile()); } catch { /* gone */ }
    try { unlinkSync(getSocketPath()); } catch { /* gone */ }
    // Give processes time to die, then force kill and exit
    setTimeout(() => {
      forceKill(openclawProc);
      forceKill(supervisorProc);
      log("sc", "Stopped");
      process.exit(0);
    }, 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  supervisorProc.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[sc] Supervisor exited (code ${code}). Restarting in 2s...`);
    setTimeout(() => {
      if (!shuttingDown) {
        supervisorProc = startSupervisor(options);
        console.log(`[sc] Supervisor restarted: PID ${supervisorProc.pid}`);
      }
    }, 2000);
  });

  openclawProc.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[sc] OpenClaw exited (code ${code}). Shutting down.`);
    shutdown();
  });

  await new Promise(() => {}); // block forever
}

// --- Dependency checking ---

interface DepStatus {
  node: boolean;
  openclaw: boolean;
  srt: boolean;
  allPresent: boolean;
}

function checkDependencies(): DepStatus {
  const node = commandExists("node");
  const openclaw = commandExists("openclaw");
  const srt = commandExists("srt");

  // Logging handled by caller

  return { node, openclaw, srt, allPresent: node && openclaw };
}

async function installMissing(deps: DepStatus): Promise<void> {
  if (!deps.node) {
    console.error("  Node.js is required. Install: https://nodejs.org/");
    process.exit(1);
  }

  const manifest = loadManifest();
  const installCwd = manifest?.installDir ?? getInstallDir();

  if (!deps.openclaw) {
    console.log("  Installing OpenClaw...");
    try {
      execFileSync("npm", ["install", "--save", "openclaw"], {
        stdio: "inherit",
        cwd: installCwd,
      });
      console.log("  [ok] OpenClaw installed");
    } catch {
      console.error("  Failed. Install manually: npm install --save openclaw");
      process.exit(1);
    }
  }

  if (!deps.srt) {
    console.log("  Installing srt...");
    try {
      execFileSync("npm", ["install", "--save", "@anthropic-ai/sandbox-runtime"], {
        stdio: "inherit",
        cwd: installCwd,
      });
      console.log("  [ok] srt installed");
    } catch {
      console.warn("  WARNING: srt not installed. Running WITHOUT kernel sandbox.");
    }
  }
}

// --- Process management ---

function startSupervisor(options: { foreground?: boolean } = {}): ChildProcess {
  const manifest = loadManifest();
  const supervisorPath = findPath([
    process.env.SHARKCAGE_SUPERVISOR_PATH,
    manifest ? resolve(manifest.installDir, "src/supervisor/main.ts") : undefined,
    resolve(repoRoot, "src/supervisor/main.ts"),
  ]);

  if (!supervisorPath) {
    console.error("Cannot find supervisor. Set SHARKCAGE_SUPERVISOR_PATH.");
    process.exit(1);
  }

  const tsxBin = manifest ? resolve(manifest.installDir, "node_modules/.bin/tsx") : "tsx";
  const proc = spawn(tsxBin, [supervisorPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: passEnvVars(),
    ...(options.foreground ? {} : { detached: true }),
  });
  prefixOutput(proc, "supervisor");
  return proc;
}

// Module-level so it's accessible after startup for printing
let gatewayToken = "";

function startOpenClaw(runAsUser?: string, options: { foreground?: boolean } = {}): ChildProcess {
  // Use OpenClaw's configured token if available, then env var, then generate
  gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!gatewayToken) {
    try {
      const ocConfig = JSON.parse(readFileSync(`${getInstallDir()}/.openclaw/openclaw.json`, "utf-8"));
      gatewayToken = ocConfig.gateway?.auth?.token ?? "";
    } catch { /* no config */ }
  }
  if (!gatewayToken) {
    gatewayToken = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  }
  const args = ["gateway", "run", "--port", "18789", "--auth", "token", "--token", gatewayToken];

  // No outer srt sandbox — the gateway process runs unsandboxed.
  // Security is enforced per-tool-call: every bash/file operation the AI
  // executes goes through `srt --settings <policy>` via the sandbox backend.
  // Skills get per-skill srt sandboxes. The gateway itself just serves chat.

  // Resolve openclaw binary — prefer manifest, then PATH lookup
  const manifest = loadManifest();
  let openclawBin = manifest?.openclawBin ?? "openclaw";
  if (!existsSync(openclawBin)) {
    try {
      openclawBin = execFileSync("which", ["openclaw"], { encoding: "utf-8" }).trim();
    } catch { /* fall back to bare name */ }
  }

  // Smart sudo: only use sudo if current user differs from runAsUser
  const needsSudo = runAsUser && process.env.USER !== runAsUser;
  const cmd = needsSudo ? "sudo" : openclawBin;
  const cmdArgs = needsSudo ? ["-u", runAsUser, openclawBin, ...args] : args;
  const proc = spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: getInstallDir() },
    ...(options.foreground ? {} : { detached: true }),
  });
  prefixOutput(proc, "openclaw");
  return proc;
}

// --- OpenClaw plugin registration ---

function ensureOpenClawPluginRegistered(): void {
  const ocConfigPath = `${getInstallDir()}/.openclaw/openclaw.json`;
  if (!existsSync(ocConfigPath)) {
    console.log("  [skip] OpenClaw config not found yet\n");
    return;
  }

  try {
    const config = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.load) config.plugins.load = {};
    if (!config.plugins.load.paths) config.plugins.load.paths = [];

    const pluginPath = findPath([
      resolve(repoRoot, "dist/sharkcage"),
      resolve(getPluginDir(), "openclaw-plugin"),
    ]);

    if (!pluginPath) {
      log("sc", "Plugin not found — skipping OpenClaw registration");
      return;
    }

    const paths: string[] = config.plugins.load.paths;
    let changed = false;

    if (!paths.includes(pluginPath)) {
      paths.push(pluginPath);
      changed = true;
      log("sc", "Plugin registered with OpenClaw");
    } else {
      log("sc", "Plugin already registered");
    }

    // Skills: --skip-skills during onboard means no bundled skills installed.
    // Third-party skills are managed through sharkcage's plugin system.
    // No lockdown needed — there's nothing to lock down.

    // Enable ASRT sandbox backend for per-session isolation
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.sandbox) config.agents.defaults.sandbox = {};
    if (config.agents.defaults.sandbox.backend !== "asrt" || config.agents.defaults.sandbox.mode !== "all") {
      config.agents.defaults.sandbox.mode = "all";
      config.agents.defaults.sandbox.backend = "asrt";
      changed = true;
      log("sc", "Per-session ASRT sandboxing enabled");
    }

    if (changed) {
      writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + "\n");
    }
  } catch {
    log("sc", "Could not read OpenClaw config — skipping plugin registration");
  }
}

// --- Helpers ---

function commandExists(cmd: string): boolean {
  const manifest = loadManifest();
  // Check manifest path first
  if (cmd === "openclaw" && manifest?.openclawBin && existsSync(manifest.openclawBin)) return true;
  if (cmd === "srt" && manifest?.srtBin && existsSync(manifest.srtBin)) return true;
  // Fall back to which
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findPath(candidates: (string | undefined)[]): string | null {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function passEnvVars(): Record<string, string> {
  const keys = [
    "HOME", "PATH", "NODE_PATH",
    "SHARKCAGE_DIR", "SHARKCAGE_CONFIG_DIR", "SHARKCAGE_DATA_DIR", "SHARKCAGE_PLUGIN_DIR", "SHARKCAGE_SOCKET",
    "HA_URL", "HA_TOKEN", "MEALS_API_URL", "MEALS_API_TOKEN",
    "NOMAD_ADDR", "NOMAD_TOKEN", "OPENROUTER_API_KEY",
    "BRIEFING_API_URL", "BRIEFING_API_TOKEN",
  ];
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function safeKill(proc: ChildProcess): void {
  if (!proc.pid) return;
  // Kill the process group (detached processes are group leaders)
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* dead */ }
  // Fallback: kill just the process
  try { proc.kill("SIGTERM"); } catch { /* dead */ }
}

function forceKill(proc: ChildProcess): void {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* dead */ }
  try { proc.kill("SIGKILL"); } catch { /* dead */ }
}

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const sock = connect({ path });
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`Timeout: ${path}`));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout: ${url}`);
}
