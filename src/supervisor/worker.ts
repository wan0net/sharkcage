import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ToolCallRequest, ToolCallResponse, SandboxViolation } from "./types.js";
import { buildAsrtConfig, writeAsrtConfig } from "./sandbox.js";
import type { SkillApproval } from "./types.js";
import type { TokenRegistry } from "./token-registry.js";

/**
 * Parse sandbox violation details from subprocess stderr.
 * Returns null if no recognisable violation is found.
 * Detection is best-effort regex — not exhaustive.
 */
export function parseSandboxViolation(stderr: string): SandboxViolation | null {
  // Network: ECONNREFUSED / ENOTFOUND — extract hostname
  const networkMatch = stderr.match(/(?:ECONNREFUSED|ENOTFOUND)\s+([^\s:,]+)/);
  if (networkMatch) {
    return {
      type: "network",
      target: networkMatch[1],
      detail: stderr.slice(0, 500),
    };
  }

  // Filesystem: "Operation not permitted" near a path
  const fsMatch = stderr.match(/Operation not permitted[^\n]*?(\/[^\s,'"]+)/);
  if (fsMatch) {
    return {
      type: "filesystem",
      target: fsMatch[1],
      detail: stderr.slice(0, 500),
    };
  }

  // Exec: "sandbox" + "denied" (ASRT generic denial)
  if (/sandbox/i.test(stderr) && /denied/i.test(stderr)) {
    // Try to extract a binary name or path from the message
    const execMatch = stderr.match(/denied[^\n]*?(\/[^\s,'"]+|[a-zA-Z][\w.-]+)/);
    return {
      type: "exec",
      target: execMatch ? execMatch[1] : "unknown",
      detail: stderr.slice(0, 500),
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
  try {
    const manifest = JSON.parse(readFileSync(`${skillDir}/plugin.json`, "utf-8"));
    runtime = manifest.runtime ?? "node";
  } catch { /* use default */ }

  // Build the inner command based on runtime
  const entryPoint = `${skillDir}/mod.ts`;
  let innerCmd: string[];
  switch (runtime) {
    case "deno":
      innerCmd = ["deno", "run", "--allow-all", entryPoint];
      break;
    case "node":
    default:
      // Use tsx for TypeScript support, or node for .js
      if (entryPoint.endsWith(".ts")) {
        innerCmd = ["npx", "tsx", entryPoint];
      } else {
        innerCmd = ["node", entryPoint];
      }
      break;
  }

  // srt wraps the process with kernel-level sandbox
  // ASRT handles all filesystem/network restrictions — the runtime flags don't matter
  const srtCmd = [
    "srt",
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

  try {
    const child = spawn(srtCmd[0], srtCmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env,
        ...proxyEnv,
        // Don't leak supervisor env vars to the skill
        SHARKCAGE_TOOL_CALL: "1",
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
    const child = spawn("srt", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}
