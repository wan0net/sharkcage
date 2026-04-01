import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ToolCallRequest, ToolCallResponse, SandboxViolation } from "./types.js";
import { buildAsrtConfig, writeAsrtConfig } from "./sandbox.js";
import { CAPABILITY_RESOURCE_MAP } from "./capabilities.js";
import type { SkillApproval } from "./types.js";
import type { TokenRegistry } from "./proxy.js";

/** Strip control characters and newlines from a string, limit to maxLen chars. */
function sanitiseField(value: string, maxLen = 256): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, maxLen);
}

/** Return true if the string looks like a valid hostname or IP address. */
function isValidHostOrIp(value: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  // IPv6 (supports bracketed [::1] and raw ::1)
  const v6 = value.replace(/^\[/, "").replace(/\]$/, "");
  if (/^[0-9a-fA-F:]{2,39}$/.test(v6)) return true;
  // Hostname / domain (RFC 952 / 1123 labels, including localhost)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(value)) return true;
  return false;
}

/** Resolved absolute path to the node binary */
const NODE_BIN = process.execPath;

/**
 * Resolve the absolute path to a binary in the sharkcage install directory.
 */
function resolveSharkcageBin(binName: string): string {
  const installDir = process.env.SHARKCAGE_DIR ?? "/opt/sharkcage";
  return `${installDir}/node_modules/.bin/${binName}`;
}

/**
 * Parse sandbox violation details from subprocess stderr.
 * Returns null if no recognisable violation is found.
 * Detection is best-effort regex — not exhaustive.
 */
export function parseSandboxViolation(stderr: string): SandboxViolation | null {
  const sanitisedDetail = sanitiseField(stderr.slice(0, 500), 500);

  // Network: ECONNREFUSED / ENOTFOUND — extract hostname
  const networkMatch = stderr.match(/(?:ECONNREFUSED|ENOTFOUND)\s+([^\s:,]+)/);
  if (networkMatch) {
    const rawTarget = sanitiseField(networkMatch[1]);
    // Validate: must look like a real hostname or IP, not injected garbage
    const target = isValidHostOrIp(rawTarget) ? rawTarget : "invalid-target";
    return {
      type: "network",
      target,
      detail: sanitisedDetail,
    };
  }

  // Filesystem: "Operation not permitted" near a path
  const fsMatch = stderr.match(/Operation not permitted[^\n]*?(\/[^\s,'"]+)/);
  if (fsMatch) {
    return {
      type: "filesystem",
      target: sanitiseField(fsMatch[1]),
      detail: sanitisedDetail,
    };
  }

  // Exec: "sandbox" + "denied" (ASRT generic denial)
  if (/sandbox/i.test(stderr) && /denied/i.test(stderr)) {
    // Try to extract a binary name or path from the message
    const execMatch = stderr.match(/denied[^\n]*?(\/[^\s,'"]+|[a-zA-Z][\w.-]+)/);
    return {
      type: "exec",
      target: execMatch ? sanitiseField(execMatch[1]) : "unknown",
      detail: sanitisedDetail,
    };
  }

  return null;
}

/**
 * Execute a tool call in an ASRT-sandboxed subprocess.
 *
 * The subprocess runs:
 *   srt --settings <config.json> <runtime> <entry-point>
 *
 * ASRT (Anthropic Sandbox Runtime) enforces filesystem and network
 * restrictions at the kernel level. The runtime (node/deno) just
 * runs the code — it has no idea it's sandboxed.
 *
 * Tool call is passed via stdin as JSON. Result read from stdout.
 */
export async function executeInSandbox(
  request: ToolCallRequest,
  approval: SkillApproval,
  skillDir: string,
  env?: Record<string, string>,
  tokenRegistry?: TokenRegistry
): Promise<ToolCallResponse> {
  const start = Date.now();

  // Build ASRT config from approved capabilities
  const asrtConfig = buildAsrtConfig(approval.capabilities, env);
  const configPath = writeAsrtConfig(request.skill, asrtConfig);

  // Determine skill runtime from plugin.json (default: node)
  let runtime = "node";
  let manifestMain: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(`${skillDir}/plugin.json`, "utf-8"));
    runtime = manifest.runtime ?? "node";
    manifestMain = typeof manifest.main === "string" ? manifest.main : null;
  } catch { /* use default */ }

  // Build the inner command based on runtime
  const entryPoint = manifestMain
    ? `${skillDir}/${manifestMain}`
    : existsSync(`${skillDir}/mod.ts`)
      ? `${skillDir}/mod.ts`
      : `${skillDir}/mod.js`;
  let innerCmd: string[];
  switch (runtime) {
    case "deno":
      // Resolve deno path at runtime if possible, else assume it's on PATH
      innerCmd = ["deno", "run", "--allow-all", entryPoint];
      break;
    case "node":
    default:
      // Use absolute path for node and tsx
      if (entryPoint.endsWith(".ts")) {
        innerCmd = [NODE_BIN, resolveSharkcageBin("tsx"), entryPoint];
      } else {
        innerCmd = [NODE_BIN, entryPoint];
      }
      break;
  }

  // srt wraps the process with kernel-level sandbox
  // ASRT handles all filesystem/network restrictions — the runtime flags don't matter
  const srtBin = resolveSharkcageBin("srt");
  const srtCmd = [
    srtBin,
    "--settings", configPath,
    ...innerCmd,
  ];

  // Pass tool call via stdin
  const input = JSON.stringify({
    tool: request.tool,
    args: request.args,
  });

  // Issue a proxy token for this subprocess (if TokenRegistry is wired up)
  const proxyToken = tokenRegistry
    ? tokenRegistry.issue(request.skill, approval.capabilities)
    : null;

  const proxyEnv: Record<string, string> = proxyToken
    ? {
        ALL_PROXY: `socks5://${proxyToken}:x@127.0.0.1:18800`,
        HTTP_PROXY: `socks5://${proxyToken}:x@127.0.0.1:18800`,
        HTTPS_PROXY: `socks5://${proxyToken}:x@127.0.0.1:18800`,
      }
    : {};

  // Scope environment variables: only pass tokens if the skill has the required capability
  const scopedEnv: Record<string, string> = {};
  if (env) {
    for (const cap of approval.capabilities) {
      const resource = CAPABILITY_RESOURCE_MAP[cap.capability];
      
      // 1. Pass environment variables mapped to this capability
      if (resource?.env) {
        for (const varName of resource.env) {
          if (env[varName]) scopedEnv[varName] = env[varName];
        }
      }

      // 2. Special case: system.env capability scope contains explicit variable names
      if (cap.capability === "system.env" && cap.scope) {
        for (const varName of cap.scope) {
          if (env[varName]) scopedEnv[varName] = env[varName];
        }
      }
    }
  }

  try {
    const child = spawn(srtCmd[0], srtCmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...scopedEnv,
        ...proxyEnv,
        // Don't leak supervisor env vars to the skill
        SHARKCAGE_TOOL_CALL: "1",
        PATH: process.env.PATH, // keep PATH for subprocesses
      },
    });

    // Write tool call to stdin
    child.stdin.write(input);
    child.stdin.end();

    // Read stdout and stderr
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Wait for exit
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => {
        if (proxyToken && tokenRegistry) {
          tokenRegistry.revoke(proxyToken);
        }
        try { unlinkSync(configPath); } catch { /* already gone */ }
        resolve(code ?? 1);
      });
    });

    const duration = Date.now() - start;

    if (exitCode !== 0) {
      const violation = parseSandboxViolation(stderr);
      return {
        id: request.id,
        result: "",
        error: `Skill exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        durationMs: duration,
        ...(violation ? { violation } : {}),
      };
    }

    return {
      id: request.id,
      result: stdout,
      durationMs: duration,
    };
  } catch (err) {
    try { unlinkSync(configPath); } catch { /* already gone */ }
    return {
      id: request.id,
      result: "",
      error: `Failed to spawn sandbox: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Check if srt (ASRT) is available on the system.
 */
export async function checkAsrtAvailable(): Promise<boolean> {
  try {
    const srtPath = `${process.env.SHARKCAGE_DIR ?? "/opt/sharkcage"}/node_modules/.bin/srt`;
    const child = spawn(srtPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}
