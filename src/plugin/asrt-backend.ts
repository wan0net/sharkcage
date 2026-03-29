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

// --- Types ---

interface AsrtSessionPolicy {
  network: {
    allowedDomains: string[];
    allowUnixSockets?: boolean;
  };
  filesystem: {
    allowRead?: string[];
    allowWrite: string[];
    denyRead: string[];
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

/** Paths that are always denied regardless of session config */
const MANDATORY_DENY_READ = [
  `${home}/.ssh`,
  `${home}/.aws`,
  `${home}/.gnupg`,
  `${home}/.config/sharkcage/approvals`,
  `${home}/.config/sharkcage/gateway-sandbox.json`,
  `${home}/.bashrc`,
  `${home}/.zshrc`,
  `${home}/.gitconfig`,
  `${home}/.netrc`,
  `${home}/.npmrc`,
];

function buildSessionPolicy(
  workspaceDir: string,
  agentWorkspaceDir: string
): AsrtSessionPolicy {
  return {
    network: {
      allowedDomains: [], // sessions don't need outbound network by default
      allowUnixSockets: true, // needed for supervisor IPC
    },
    filesystem: {
      allowRead: [
        "/usr",
        "/lib",
        "/lib64",
        "/bin",
        "/sbin",
        "/etc",
        "/opt/homebrew", // macOS Homebrew
        "/tmp",
        "/var/folders", // macOS temp scratch space
        "/Library/Frameworks/Python.framework", // macOS system Python
        "/usr/bin/python3",
        workspaceDir,
        agentWorkspaceDir,
        `${home}/.node_modules`,
        `${home}/.npm`,
        `${home}/.local/share`,
      ],
      allowWrite: [
        "/tmp",
        "/var/folders",
        workspaceDir,
        agentWorkspaceDir,
      ],
      denyRead: MANDATORY_DENY_READ,
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
        env: { ...process.env, ...env, HOME: process.env.HOME ?? "" },
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
          env: { ...process.env, HOME: process.env.HOME ?? "" },
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

  // registerSandboxBackend is a module-level export, not on the plugin API
  let registerSandboxBackend: ((id: string, registration: unknown) => void) | null = null;
  try {
    const modulePath = "openclaw/plugin-sdk/sandbox";
    const sandboxModule = await import(/* @vite-ignore */ modulePath);
    registerSandboxBackend = sandboxModule.registerSandboxBackend ?? null;
  } catch {
    // OpenClaw sandbox module not available in this context
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
