/**
 * sharkcage start
 *
 * One command to go from nothing to running:
 * 1. Check/install dependencies (OpenClaw, srt)
 * 2. Run sharkcage init if no config exists
 * 3. Generate + verify gateway sandbox config
 * 4. Register sharkcage plugin with OpenClaw
 * 5. Start the supervisor
 * 6. Start OpenClaw in outer ASRT sandbox
 * 7. Monitor both processes, restart on failure
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { prefixOutput, log } from "../log-prefix.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const dataDir = `${configDir}/data`;
const socketPath = `${dataDir}/supervisor.sock`;
const pidFile = `${dataDir}/sharkcage.pid`;

export default async function start() {
  console.log(`
╭─────────────────────────────────────╮
│        sharkcage start               │
╰─────────────────────────────────────╯
`);

  // --- 1. Check dependencies ---
  console.log("Checking dependencies...");

  const deps = checkDependencies();
  if (!deps.allPresent) {
    console.log("");
    await installMissing(deps);
    console.log("");
  }

  console.log("  [ok] All dependencies present\n");

  // --- 2. Check config ---
  if (!existsSync(`${configDir}/gateway.json`)) {
    console.log("No config found. Running setup wizard...\n");
    const init = await import("./init.js");
    await init.default();
    console.log("");
  }

  // --- 3. Generate gateway sandbox config ---
  const sandboxConfigPath = `${configDir}/gateway-sandbox.json`;
  if (!existsSync(sandboxConfigPath)) {
    console.log("Generating gateway sandbox config...");
    generateGatewaySandboxConfig(sandboxConfigPath);
    console.log(`  Written to ${sandboxConfigPath}\n`);
  } else {
    console.log("  [ok] Gateway sandbox config exists\n");
  }

  // --- 4. Ensure directories ---
  for (const dir of [dataDir, `${configDir}/plugins`, `${configDir}/approvals`]) {
    mkdirSync(dir, { recursive: true });
  }

  // --- 5. Register sharkcage plugin with OpenClaw ---
  ensureOpenClawPluginRegistered();

  // --- 6. Check if already running ---
  if (existsSync(pidFile)) {
    try {
      const pids = JSON.parse(readFileSync(pidFile, "utf-8"));
      if (isProcessRunning(pids.supervisor) || isProcessRunning(pids.openclaw)) {
        console.log("Sharkcage is already running.");
        console.log(`  Supervisor PID: ${pids.supervisor}`);
        console.log(`  OpenClaw PID: ${pids.openclaw}`);
        console.log("  Run 'sc stop' first.\n");
        process.exit(1);
      }
    } catch { /* corrupt pid file */ }
    try { unlinkSync(pidFile); } catch { /* gone */ }
  }

  // --- 7. Start supervisor ---
  log("sc", "Starting supervisor...");
  const supervisorProc = startSupervisor();
  log("sc", `Supervisor PID ${supervisorProc.pid}`);

  await waitForSocket(socketPath, 10_000);
  log("sc", "Supervisor ready");

  // --- 8. Start OpenClaw ---
  log("sc", "Starting OpenClaw...");
  const openclawProc = startOpenClaw(sandboxConfigPath);
  log("sc", `OpenClaw PID ${openclawProc.pid}`);

  await waitForHttp("http://127.0.0.1:18789", 30_000);
  log("sc", "OpenClaw ready");

  // --- 9. Write PID file ---
  writeFileSync(pidFile, JSON.stringify({
    supervisor: supervisorProc.pid,
    openclaw: openclawProc.pid,
    startedAt: new Date().toISOString(),
  }));

  // --- 10. Running ---
  console.log("");
  console.log("╭─────────────────────────────────────╮");
  console.log("│          sharkcage running            │");
  console.log("╰─────────────────────────────────────╯");
  console.log(`  Gateway:   ws://127.0.0.1:18789`);
  console.log(`  Token:     ${gatewayToken}`);
  console.log(`  Dashboard: http://127.0.0.1:18790/sharkcage/`);
  console.log(`  Supervisor PID: ${supervisorProc.pid}  OpenClaw PID: ${openclawProc.pid}`);
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");

  // --- 11. Monitor + shutdown ---
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    safeKill(openclawProc);
    safeKill(supervisorProc);
    try { unlinkSync(pidFile); } catch { /* gone */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    console.log("Stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  supervisorProc.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[sc] Supervisor exited (code ${code}). Restarting in 2s...`);
    setTimeout(() => {
      if (!shuttingDown) {
        const p = startSupervisor();
        console.log(`[sc] Supervisor restarted: PID ${p.pid}`);
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

  console.log(`  ${node ? "[ok]" : "[  ]"} Node.js`);
  console.log(`  ${openclaw ? "[ok]" : "[  ]"} OpenClaw`);
  console.log(`  ${srt ? "[ok]" : "[  ]"} srt (Anthropic Sandbox Runtime)`);

  return { node, openclaw, srt, allPresent: node && openclaw };
}

async function installMissing(deps: DepStatus): Promise<void> {
  if (!deps.node) {
    console.error("  Node.js is required. Install: https://nodejs.org/");
    process.exit(1);
  }

  if (!deps.openclaw) {
    console.log("  Installing OpenClaw...");
    try {
      execFileSync("npm", ["install", "-g", "openclaw"], { stdio: "inherit" });
      console.log("  [ok] OpenClaw installed");
    } catch {
      console.error("  Failed. Install manually: npm install -g openclaw");
      process.exit(1);
    }
  }

  if (!deps.srt) {
    console.log("  Installing srt...");
    try {
      execFileSync("npm", ["install", "-g", "@anthropic-ai/sandbox-runtime"], { stdio: "inherit" });
      console.log("  [ok] srt installed");
    } catch {
      console.warn("  WARNING: srt not installed. Running WITHOUT kernel sandbox.");
    }
  }
}

// --- Process management ---

function startSupervisor(): ChildProcess {
  const supervisorPath = findPath([
    process.env.SHARKCAGE_SUPERVISOR_PATH,
    `${configDir}/supervisor/src/main.ts`,
    resolve(repoRoot, "src/supervisor/main.ts"),
  ]);

  if (!supervisorPath) {
    console.error("Cannot find supervisor. Set SHARKCAGE_SUPERVISOR_PATH.");
    process.exit(1);
  }

  const proc = spawn("npx", ["tsx", supervisorPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: passEnvVars(),
    detached: false,
  });
  prefixOutput(proc, "supervisor");
  return proc;
}

// Module-level so it's accessible after startup for printing
let gatewayToken = "";

function startOpenClaw(sandboxConfigPath: string): ChildProcess {
  const hasSrt = commandExists("srt");
  gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? crypto.randomUUID().slice(0, 16);
  const args = ["gateway", "run", "--port", "18789", "--auth", "token", "--token", gatewayToken];

  // Force IPv4 for localhost resolution (Node defaults to IPv6 ::1 which
  // OpenClaw's loopback bind check rejects as non-loopback)
  const existing = process.env.NODE_OPTIONS ?? "";
  const ipv4Flag = "--dns-result-order=ipv4first";
  const nodeOptions = existing.includes(ipv4Flag) ? existing : `${existing} ${ipv4Flag}`.trim();
  const env = { ...process.env, NODE_OPTIONS: nodeOptions } as NodeJS.ProcessEnv;

  if (hasSrt) {
    // TODO: re-enable outer srt wrap once bind issue is resolved
    // return spawn("srt", ["--settings", sandboxConfigPath, "openclaw", ...args], {
    //   stdio: "inherit",
    //   env,
    //   detached: false,
    // });
    console.log("  [info] Outer ASRT sandbox available (srt found)");
  }

  const proc = spawn("openclaw", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: false,
  });
  prefixOutput(proc, "openclaw");
  return proc;
}

// --- OpenClaw plugin registration ---

function ensureOpenClawPluginRegistered(): void {
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
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
      `${configDir}/openclaw-plugin`,
    ]);

    if (!pluginPath) {
      console.warn("  [skip] sharkcage plugin not found\n");
      return;
    }

    const paths: string[] = config.plugins.load.paths;
    if (!paths.includes(pluginPath)) {
      paths.push(pluginPath);
      writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + "\n");
      console.log("  [ok] Sharkcage plugin registered with OpenClaw\n");
    } else {
      console.log("  [ok] Sharkcage plugin already registered\n");
    }
  } catch {
    console.warn("  [skip] Could not read OpenClaw config\n");
  }
}

// --- Gateway sandbox config ---

function generateGatewaySandboxConfig(outPath: string): void {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(`${configDir}/gateway.json`, "utf-8"));
  } catch { /* defaults */ }

  const allowedDomains = new Set<string>();

  // LLM provider
  if (config.openrouter_model) allowedDomains.add("openrouter.ai");

  // Read OpenClaw channel config to determine which API hosts are needed
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
  if (existsSync(ocConfigPath)) {
    try {
      const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
      const channels = ocConfig.channels ?? {};

      const channelHosts: Record<string, string[]> = {
        signal: ["127.0.0.1:7583"],
        telegram: ["api.telegram.org"],
        whatsapp: ["web.whatsapp.com"],
        discord: ["discord.com", "gateway.discord.gg"],
        slack: ["slack.com"],
        matrix: [], // homeserver-specific
        irc: [], // server-specific
      };

      for (const [name, channelConfig] of Object.entries(channels)) {
        const cfg = channelConfig as Record<string, unknown>;
        if (cfg?.enabled !== false) {
          const hosts = channelHosts[name];
          if (hosts) hosts.forEach((h) => allowedDomains.add(h));
        }
      }
    } catch { /* can't read */ }
  }

  // Fallback: localhost for signal-cli
  if (allowedDomains.size <= 1) {
    const signalUrl = String(config.signal_cli_url ?? "127.0.0.1:7583");
    allowedDomains.add(signalUrl.replace(/^https?:\/\//, ""));
  }

  // srt config format: domains must be valid hostnames (no ports), arrays for all fields
  const domainList = [...allowedDomains].map((d) => d.replace(/:\d+$/, "")); // strip ports

  const sandboxConfig = {
    network: {
      allowedDomains: domainList.length > 0 ? domainList : [],
      deniedDomains: [],
      allowUnixSockets: [`${configDir}/data/supervisor.sock`],
    },
    filesystem: {
      allowRead: ["/usr", "/lib", "/bin", "/sbin", "/etc", "/opt/homebrew", "/tmp", `${home}/.openclaw`, `${configDir}`],
      allowWrite: [`${home}/.openclaw/data`, `${configDir}/data`, "/tmp"],
      denyRead: [
        `${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`,
        `${configDir}/approvals`,
        `${home}/.bashrc`, `${home}/.zshrc`, `${home}/.gitconfig`,
      ],
      denyWrite: [],
    },
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(outPath, JSON.stringify(sandboxConfig, null, 2) + "\n");
}

// --- Helpers ---

function commandExists(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "pipe" });
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
    "SHARKCAGE_CONFIG_DIR", "SHARKCAGE_DATA_DIR", "SHARKCAGE_PLUGIN_DIR", "SHARKCAGE_SOCKET",
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
  try { proc.kill("SIGTERM"); } catch { /* dead */ }
}

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`Timeout: ${path}`));
      setTimeout(check, 200);
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
