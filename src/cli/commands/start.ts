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
import { createConnection, type Socket } from "node:net";
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

  // --- 6b. Pre-sync CLI auth credentials before sandboxing ---
  // CLI-based auth (Claude CLI, Codex CLI, etc.) stores credentials in the
  // keychain. The sandbox blocks keychain access, but the file-based fallback
  // works. Ensure the file fallback exists by reading keychain BEFORE sandbox.
  const credFile = `${home}/.claude/.credentials.json`;
  if (!existsSync(credFile)) {
    try {
      const raw = execFileSync("security", [
        "find-generic-password", "-s", "Claude Code-credentials", "-w"
      ], { encoding: "utf-8", timeout: 10_000 }).trim();
      if (raw) {
        writeFileSync(credFile, raw, { mode: 0o600 });
        log("sc", "CLI credentials exported for sandbox");
      }
    } catch {
      // No keychain entry or user declined — not all providers use keychain
    }
  }

  // --- 7. Start supervisor ---
  log("sc", "Starting supervisor...");
  const supervisorProc = startSupervisor();
  log("sc", `Supervisor PID ${supervisorProc.pid}`);

  await waitForSocket(socketPath, 10_000);
  log("sc", "Supervisor ready");

  // --- 7b. Connect to supervisor socket for FD-inherited IPC ---
  // The plugin inside srt can't create new sockets (BPF blocks socket()),
  // so we connect here and pass the connected FD to the sandboxed process.
  const ipcConn = createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    ipcConn.on("connect", resolve);
    ipcConn.on("error", reject);
  });
  log("sc", "IPC connection established for FD inheritance");

  // --- 8. Start OpenClaw ---
  log("sc", "Starting OpenClaw...");
  const openclawProc = startOpenClaw(sandboxConfigPath, ipcConn);
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
  log("sc", `Web UI:    http://127.0.0.1:18789/#token=${gatewayToken}`);
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

function startOpenClaw(sandboxConfigPath: string, ipcSocket?: Socket): ChildProcess {
  const hasSrt = commandExists("srt");
  // Use OpenClaw's configured token if available, then env var, then generate
  gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!gatewayToken) {
    try {
      const ocConfig = JSON.parse(readFileSync(`${home}/.openclaw/openclaw.json`, "utf-8"));
      gatewayToken = ocConfig.gateway?.auth?.token ?? "";
    } catch { /* no config */ }
  }
  if (!gatewayToken) {
    gatewayToken = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  }
  const args = ["gateway", "run", "--port", "18789", "--auth", "token", "--token", gatewayToken];

  // Node options for sandboxed OpenClaw:
  // --dns-result-order=ipv4first: prevent IPv6 ::1 for localhost (breaks bind check)
  // --use-env-proxy: route fetch() through srt's HTTP/SOCKS proxy (required for DNS)
  const flags = ["--dns-result-order=ipv4first", "--use-env-proxy"];
  let nodeOptions = process.env.NODE_OPTIONS ?? "";
  for (const flag of flags) {
    if (!nodeOptions.includes(flag)) nodeOptions = `${nodeOptions} ${flag}`.trim();
  }
  const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: nodeOptions };

  // FD inheritance: pass the pre-connected supervisor socket as FD 3.
  // srt/bwrap preserves inherited FDs (not marked CLOEXEC), so the plugin
  // can use it even inside the sandbox where socket() is blocked by BPF.
  const stdio: Array<"pipe" | Socket> = ["pipe", "pipe", "pipe"];
  if (ipcSocket) {
    stdio.push(ipcSocket); // FD 3 in the child
    env.SHARKCAGE_IPC_FD = "3";
  }

  if (hasSrt) {
    log("sc", "Outer ASRT sandbox enabled");
    const proc = spawn("srt", ["--settings", sandboxConfigPath, "openclaw", ...args], {
      stdio,
      env: env as NodeJS.ProcessEnv,
      detached: false,
    });
    prefixOutput(proc, "openclaw");
    return proc;
  }
  const proc = spawn("openclaw", args, {
    stdio,
    env: env as NodeJS.ProcessEnv,
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

// --- Gateway sandbox config ---

function generateGatewaySandboxConfig(outPath: string): void {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(`${configDir}/gateway.json`, "utf-8"));
  } catch { /* defaults */ }

  const allowedDomains = new Set<string>();

  // LLM provider — detect from OpenClaw's configured model
  const providerDomains: Record<string, string[]> = {
    anthropic: ["api.anthropic.com"],
    openai: ["api.openai.com"],
    "openai-codex": ["api.openai.com", "auth.openai.com"],
    openrouter: ["openrouter.ai"],
    google: ["generativelanguage.googleapis.com"],
    xai: ["api.x.ai"],
    deepseek: ["api.deepseek.com"],
    mistral: ["api.mistral.ai"],
    together: ["api.together.xyz"],
    ollama: ["127.0.0.1"],
  };

  // Read model config to determine provider
  try {
    const ocCfg = JSON.parse(readFileSync(`${home}/.openclaw/openclaw.json`, "utf-8"));
    const model = ocCfg.agents?.defaults?.model;
    const modelStr = typeof model === "string" ? model : model?.primary ?? "";
    const provider = modelStr.split("/")[0]; // e.g. "anthropic" from "anthropic/claude-3-haiku"
    const domains = providerDomains[provider];
    if (domains) domains.forEach((d) => allowedDomains.add(d));
    // Also check for claude-cli which uses anthropic API
    if (modelStr.includes("claude-cli") || modelStr.includes("claude")) {
      allowedDomains.add("api.anthropic.com");
    }
  } catch { /* can't read */ }

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
      allowWrite: [`${home}/.openclaw`, `${configDir}/data`, "/tmp"],
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
