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
  if (!existsSync(`${configDir}/gateway.json`)) {
    log("sc", "No config found — running setup wizard");
    const init = await import("./init.js");
    await init.default();
  }

  // --- 3. Generate gateway sandbox config ---
  const sandboxConfigPath = `${configDir}/gateway-sandbox.json`;
  if (!existsSync(sandboxConfigPath)) {
    generateGatewaySandboxConfig(sandboxConfigPath);
    log("sc", `Gateway sandbox config written to ${sandboxConfigPath}`);
  } else {
    log("sc", "Gateway sandbox config exists");
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
        log("sc", "Already running — run 'sc stop' first");
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
  log("sc", "━━━ sharkcage running ━━━");
  log("sc", `Gateway:   ws://127.0.0.1:18789`);
  log("sc", `Token:     ${gatewayToken}`);
  log("sc", `Web UI:    http://127.0.0.1:18789/?token=${gatewayToken}`);
  log("sc", `Dashboard: http://127.0.0.1:18789/sharkcage/?token=${gatewayToken}`);
  log("sc", `API:       http://127.0.0.1:18790/api/status`);
  log("sc", "Press Ctrl+C to stop");

  // --- 11. Monitor + shutdown ---
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("sc", "Shutting down...");
    safeKill(openclawProc);
    safeKill(supervisorProc);
    try { unlinkSync(pidFile); } catch { /* gone */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    log("sc", "Stopped");
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

  // Logging handled by caller

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
    log("sc", "Outer ASRT sandbox enabled");
    const proc = spawn("srt", ["--settings", sandboxConfigPath, "openclaw", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: false,
    });
    prefixOutput(proc, "openclaw");
    return proc;
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
      log("sc", "Plugin not found — skipping OpenClaw registration");
      return;
    }

    const paths: string[] = config.plugins.load.paths;
    if (!paths.includes(pluginPath)) {
      paths.push(pluginPath);
      writeFileSync(ocConfigPath, JSON.stringify(config, null, 2) + "\n");
      log("sc", "Plugin registered with OpenClaw");
    } else {
      log("sc", "Plugin already registered");
    }
  } catch {
    log("sc", "Could not read OpenClaw config — skipping plugin registration");
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
      allowLocalBinding: true,
      allowUnixSockets: [`${configDir}/data/supervisor.sock`],
    },
    filesystem: {
      allowRead: ["/usr", "/lib", "/bin", "/sbin", "/etc", "/opt/homebrew", "/tmp", `${home}/.openclaw`, `${configDir}`],
      allowWrite: [`${home}/.openclaw/data`, `${configDir}/data`, "/tmp"],
      denyRead: [
        // Credentials & keys
        `${home}/.ssh`,
        `${home}/.aws`,
        `${home}/.gnupg`,
        `${home}/.netrc`,
        `${home}/.npmrc`,
        `${home}/.docker`,
        `${home}/.kube`,
        `${home}/.config/gh`,
        `${home}/.config/gcloud`,
        `${home}/.config/op`,      // 1Password CLI
        `${home}/.password-store`,
        // Shell configs (can leak env vars / secrets)
        `${home}/.bashrc`,
        `${home}/.zshrc`,
        `${home}/.bash_profile`,
        `${home}/.zprofile`,
        `${home}/.profile`,
        `${home}/.bash_history`,
        `${home}/.zsh_history`,
        `${home}/.gitconfig`,
        // Sharkcage internals
        `${configDir}/approvals`,
        `${configDir}/gateway-sandbox.json`,
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
