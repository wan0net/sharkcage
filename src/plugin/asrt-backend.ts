/**
 * ASRT Sandbox Backend for OpenClaw
 *
 * Routes all bash/exec commands and file operations through `srt` instead of
 * Docker. Registered via OpenClaw's registerSandboxBackend API when `srt` is
 * found on PATH.
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MANDATORY_DENY_READ } from "../supervisor/types.js";

// --- Types ---

interface AsrtSessionPolicy {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowUnixSockets: string[];
  };
  filesystem: {
    allowRead?: string[];
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
  };
}

interface SandboxBackendHandle {
  id: string;
  runtimeId: string;
  runtimeLabel: string;
  workdir: string;
  env?: Record<string, string>;
  configLabel?: string;
  configLabelKind?: string;
  capabilities?: { browser?: boolean };
  buildExecSpec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{
    argv: string[];
    env: NodeJS.ProcessEnv;
    stdinMode: "pipe-open" | "pipe-closed";
    finalizeToken?: unknown;
  }>;
  finalizeExec?(params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }): Promise<void>;
  runShellCommand(params: {
    script: string;
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    stdout: Buffer;
    stderr: Buffer;
    code: number;
  }>;
  createFsBridge?(params: { sandbox: unknown }): unknown;
}

interface BackendManager {
  describeRuntime(params: {
    entry: { containerName: string };
    config: unknown;
    agentId?: string;
  }): Promise<{ running: boolean; configLabelMatch: boolean }>;
  removeRuntime(params: {
    entry: { containerName: string };
    config: unknown;
    agentId?: string;
  }): Promise<void>;
}

interface OpenClawPluginApiWithSandbox {
  registerSandboxBackend?(
    id: string,
    registration: {
      factory: (params: {
        sessionKey: string;
        scopeKey: string;
        workspaceDir: string;
        agentWorkspaceDir: string;
        cfg: Record<string, unknown>;
      }) => Promise<SandboxBackendHandle>;
      manager?: BackendManager;
    }
  ): void;
}

// --- Policy path helpers ---

const home = process.env.HOME ?? "";
const sessionPolicyDir = join(
  process.env.SHARKCAGE_DATA_DIR ??
    `${home}/.config/sharkcage/data`,
  "sessions"
);

function policyPathForScope(scopeKey: string): string {
  return join(sessionPolicyDir, `${scopeKey}.json`);
}

function writeSessionPolicy(scopeKey: string, policy: AsrtSessionPolicy): string {
  mkdirSync(sessionPolicyDir, { recursive: true });
  const path = policyPathForScope(scopeKey);
  writeFileSync(path, JSON.stringify(policy, null, 2));
  return path;
}

// --- Policy generation ---

// MANDATORY_DENY_READ is imported from ../supervisor/types.js — canonical list lives there.

function buildSessionPolicy(
  workspaceDir: string,
  agentWorkspaceDir: string
): AsrtSessionPolicy {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: true,
      allowUnixSockets: [],
    },
    filesystem: {
      allowRead: [
        // System binaries and libraries
        "/usr",
        "/lib",
        "/lib64",
        "/bin",
        "/sbin",
        "/etc",
        "/opt/homebrew",
        "/Library/Frameworks/Python.framework",
        "/private/var/run", // mDNSResponder for DNS (macOS)
        "/var/folders",     // macOS temp
        // User home — scoped to this user only, not /home
        home,
        // Workspace dirs (passed by OpenClaw)
        workspaceDir,
        agentWorkspaceDir,
        `${home}/.openclaw/workspace`,
        `${home}/.openclaw/sandboxes`,
        // Runtime dependencies
        `${home}/.node_modules`,
        `${home}/.npm`,
        `${home}/.nvm`,
        `${home}/.local`,
      ],
      allowWrite: [
        // Private tmp inside home — not shared /tmp
        `${home}/.openclaw/tmp`,
        "/var/folders",     // macOS temp
        workspaceDir,
        agentWorkspaceDir,
        `${home}/.openclaw/workspace`,
        `${home}/.openclaw/sandboxes`,
      ],
      denyRead: MANDATORY_DENY_READ,
      denyWrite: [],
    },
  };
}

// --- Backend factory ---

async function createAsrtBackend(params: {
  sessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: Record<string, unknown>;
}): Promise<SandboxBackendHandle> {
  const { sessionKey, scopeKey, workspaceDir, agentWorkspaceDir } = params;

  // Ensure private tmp dir exists (not shared /tmp)
  mkdirSync(`${home}/.openclaw/tmp`, { recursive: true });

  const policy = buildSessionPolicy(workspaceDir, agentWorkspaceDir);
  const policyPath = writeSessionPolicy(scopeKey, policy);

  const handle: SandboxBackendHandle = {
    id: "asrt",
    runtimeId: `asrt-${scopeKey}`,
    runtimeLabel: `asrt:${sessionKey}`,
    workdir: agentWorkspaceDir,

    async buildExecSpec({ command, env, usePty }) {
      const shell = usePty ? "/bin/bash" : "/bin/sh";
      return {
        argv: ["srt", "--settings", policyPath, shell, "-c", command],
        env: { ...process.env, ...env, HOME: process.env.HOME ?? "", TMPDIR: `${home}/.openclaw/tmp` },
        stdinMode: usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
      };
    },

    async runShellCommand({ script, args, stdin, allowFailure, signal }) {
      const shellArgs =
        args && args.length > 0
          ? ["-c", script, "--", ...args]
          : ["-c", script];

      const srtArgs = ["--settings", policyPath, "/bin/sh", ...shellArgs];

      return new Promise((resolve, reject) => {
        const child = spawn("srt", srtArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, HOME: process.env.HOME ?? "", TMPDIR: `${home}/.openclaw/tmp` },
          signal: signal ?? undefined,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        if (stdin) {
          child.stdin.write(stdin);
        }
        child.stdin.end();

        child.on("close", (code) => {
          const result = {
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            code: code ?? 1,
          };
          if (code !== 0 && !allowFailure) {
            reject(
              Object.assign(
                new Error(`srt exited with code ${code}`),
                result
              )
            );
          } else {
            resolve(result);
          }
        });

        child.on("error", reject);
      });
    },
  };

  return handle;
}

// --- Backend manager ---

const asrtBackendManager: BackendManager = {
  async describeRuntime({ entry }) {
    // containerName holds the policy file path for ASRT backends
    const policyExists = existsSync(entry.containerName);
    return {
      running: policyExists,
      configLabelMatch: true,
    };
  },

  async removeRuntime({ entry }) {
    try {
      unlinkSync(entry.containerName);
    } catch {
      // already gone — not an error
    }
  },
};

// --- Registration ---

/**
 * Register the ASRT sandbox backend with OpenClaw.
 *
 * Checks for `srt` on PATH first. If not found, logs a message and returns
 * without registering so the plugin continues to work with other backends.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAsrtBackend(api: any): Promise<void> {
  let hasSrt = false;
  try {
    execFileSync("srt", ["--version"], { stdio: "pipe" });
    hasSrt = true;
  } catch {
    // srt not installed
  }

  if (!hasSrt) {
    console.log(
      "[sharkcage] srt not found — ASRT sandbox backend not registered"
    );
    return;
  }

  // registerSandboxBackend is exported from openclaw's plugin-sdk/sandbox module.
  // Our plugin runs inside OpenClaw's process, so we resolve the module using
  // OpenClaw's own entry point (process.argv[1]) as the resolution base.
  let registerSandboxBackend: ((id: string, registration: unknown) => void) | null = null;
  try {
    const { createRequire } = await import("node:module");
    const { realpathSync } = await import("node:fs");
    // process.argv[1] may be a symlink — resolve to the real path first
    const entryPoint = realpathSync(process.argv[1] ?? "");
    const ocRequire = createRequire(entryPoint);
    const sandboxPath = ocRequire.resolve("openclaw/plugin-sdk/sandbox");
    const sandboxModule = await import(`file://${sandboxPath}`);
    registerSandboxBackend = sandboxModule.registerSandboxBackend ?? null;
  } catch (err) {
    console.log(`[sharkcage] sandbox module import failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!registerSandboxBackend) {
    console.log(
      "[sharkcage] registerSandboxBackend not available — ASRT backend skipped"
    );
    return;
  }

  console.log("[sharkcage] registering ASRT sandbox backend");

  registerSandboxBackend("asrt", {
    factory: createAsrtBackend,
    manager: asrtBackendManager,
  });
}

// Re-export types for use in index.ts
export type { SandboxBackendHandle, BackendManager, OpenClawPluginApiWithSandbox };
