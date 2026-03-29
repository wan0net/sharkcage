import type { PluginCapability, DenoPermissionMapping, CapabilityName } from "./types.js";

/**
 * Maps approved capabilities to Deno runtime permission flags.
 * This is the bridge between the user-facing permission model
 * and the actual sandbox enforcement.
 */
export function capabilitiesToDenoPermissions(
  capabilities: PluginCapability[]
): DenoPermissionMapping {
  const net = new Set<string>();
  const env = new Set<string>();
  const read = new Set<string>();
  const write = new Set<string>();
  const run = new Set<string>();
  let ffi = false;
  let netAll = false;

  for (const cap of capabilities) {
    const scope = cap.scope ?? [];

    switch (cap.capability) {
      // Network
      case "network.external":
      case "network.internal":
        if (scope.length === 0) netAll = true;
        else scope.forEach((h) => net.add(h));
        break;

      // Home — maps to HA API host
      case "home.read":
      case "home.control":
      case "home.automation":
        env.add("HA_URL");
        env.add("HA_TOKEN");
        // Net access to HA is granted via the host from HA_URL
        break;

      // Data — maps to specific API hosts + env vars
      case "data.meals":
        env.add("MEALS_API_URL");
        env.add("MEALS_API_TOKEN");
        break;
      case "data.history":
      case "data.memory":
      case "data.preferences":
        // These access the gateway's own SQLite — no extra Deno permissions needed
        // (the gateway provides these via an internal API, not direct file access)
        break;

      // Fleet — maps to Nomad API
      case "fleet.dispatch":
      case "fleet.read":
      case "fleet.manage":
        env.add("NOMAD_ADDR");
        env.add("NOMAD_TOKEN");
        break;

      // Notify
      case "notify.signal":
        env.add("SIGNAL_CLI_URL");
        env.add("SIGNAL_ACCOUNT");
        break;
      case "notify.push":
        // Maps to ntfy or similar
        break;

      // System (dangerous)
      case "system.files.read":
        if (scope.length === 0) read.add(".");
        else scope.forEach((p) => read.add(p));
        break;
      case "system.files.write":
        if (scope.length === 0) write.add(".");
        else scope.forEach((p) => write.add(p));
        break;
      case "system.exec":
        if (scope.length === 0) run.add("true"); // marker for --allow-run
        else scope.forEach((b) => run.add(b));
        break;
      case "system.env":
        if (scope.length === 0) env.add("*");
        else scope.forEach((v) => env.add(v));
        break;

      // Cost — informational, no Deno mapping
      case "cost.api":
        break;
    }
  }

  const result: DenoPermissionMapping = {};
  if (netAll) result.net = true;
  else if (net.size > 0) result.net = [...net];
  if (env.has("*")) result.env = true;
  else if (env.size > 0) result.env = [...env];
  if (read.size > 0) result.read = [...read];
  if (write.size > 0) result.write = [...write];
  if (run.size > 0) result.run = run.has("true") ? true : [...run];
  if (ffi) result.ffi = true;

  return result;
}

/**
 * Checks if a set of capabilities is "safe" (no dangerous capabilities).
 * Used for auto-approval of low-risk plugins.
 */
export function allCapabilitiesSafe(capabilities: PluginCapability[]): boolean {
  const dangerous: CapabilityName[] = [
    "system.files.write",
    "system.exec",
    "fleet.manage",
    "notify.signal",
  ];
  return !capabilities.some((c) => dangerous.includes(c.capability));
}

// ============================================================================
// ASRT Sandbox Config
// ============================================================================

/**
 * Anthropic Sandbox Runtime configuration.
 * Generated from approved capabilities, passed to srt via --settings.
 */
export interface AsrtConfig {
  network: {
    allowedDomains: string[];
    deniedDomains?: string[];
    allowUnixSockets?: boolean;
  };
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    allowRead?: string[];
    denyWrite?: string[];
  };
}

/** Paths that are ALWAYS denied regardless of capabilities */
const MANDATORY_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/sharkcage/approvals",
  "~/.config/sharkcage/gateway-sandbox.json",
  "~/.bashrc",
  "~/.zshrc",
  "~/.gitconfig",
  "~/.netrc",
  "~/.npmrc",
];

/**
 * Maps approved capabilities to an ASRT sandbox configuration.
 * This is the bridge between the user-facing capability model
 * and kernel-enforced sandbox boundaries.
 *
 * Each skill gets its own ASRT config. The config is written to
 * a temp file and passed to `srt --settings <path>`.
 */
export function capabilitiesToAsrtConfig(
  capabilities: PluginCapability[],
  envVars?: Record<string, string>
): AsrtConfig {
  const allowedDomains: string[] = [];
  const allowWrite: string[] = [];
  const allowRead: string[] = [];

  for (const cap of capabilities) {
    const scope = cap.scope ?? [];

    switch (cap.capability) {
      // Network
      case "network.external":
      case "network.internal":
        if (scope.length > 0) {
          allowedDomains.push(...scope);
        }
        // No scope = no domains added (skill gets no network by default)
        // This is intentionally strict — unscoped network is useless in ASRT
        break;

      // Home — resolve HA host from env
      case "home.read":
      case "home.control":
      case "home.automation": {
        const haUrl = envVars?.["HA_URL"] ?? "homeassistant.local:8123";
        const host = haUrl.replace(/^https?:\/\//, "");
        allowedDomains.push(host);
        break;
      }

      // Data — resolve API hosts from env
      case "data.meals": {
        const mealsUrl = envVars?.["MEALS_API_URL"] ?? "localhost:8788";
        const host = mealsUrl.replace(/^https?:\/\//, "");
        allowedDomains.push(host);
        break;
      }

      // Fleet — resolve Nomad host from env
      case "fleet.dispatch":
      case "fleet.read":
      case "fleet.manage": {
        const nomadAddr = envVars?.["NOMAD_ADDR"] ?? "localhost:4646";
        const host = nomadAddr.replace(/^https?:\/\//, "");
        allowedDomains.push(host);
        break;
      }

      // Filesystem
      case "system.files.read":
        if (scope.length > 0) allowRead.push(...scope);
        break;
      case "system.files.write":
        if (scope.length > 0) allowWrite.push(...scope);
        break;

      // Exec, env, notify, cost — handled by the supervisor process,
      // not by ASRT filesystem/network config
      case "system.exec":
      case "system.env":
      case "notify.signal":
      case "notify.push":
      case "cost.api":
      case "data.history":
      case "data.memory":
      case "data.preferences":
        break;
    }
  }

  return {
    network: {
      allowedDomains: [...new Set(allowedDomains)],
      allowUnixSockets: false,
    },
    filesystem: {
      allowWrite,
      denyRead: [...MANDATORY_DENY_READ],
      ...(allowRead.length > 0 ? { allowRead } : {}),
    },
  };
}

/**
 * Generate the outer gateway ASRT config from init-time service choices.
 */
export function gatewayAsrtConfig(services: {
  signalCli?: string;
  llmProvider?: string;
  additionalHosts?: string[];
}): AsrtConfig {
  const allowedDomains: string[] = [];

  // Signal CLI (localhost)
  if (services.signalCli) allowedDomains.push(services.signalCli);

  // LLM provider
  if (services.llmProvider) allowedDomains.push(services.llmProvider);

  // Any additional configured hosts
  if (services.additionalHosts) allowedDomains.push(...services.additionalHosts);

  return {
    network: {
      allowedDomains,
      allowUnixSockets: true, // gateway needs unix sockets for supervisor IPC
    },
    filesystem: {
      allowWrite: ["~/.openclaw/data", "~/.config/sharkcage/data"],
      denyRead: [...MANDATORY_DENY_READ],
    },
  };
}
