import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SandboxViolation } from "../supervisor/types.js";
import { getApprovalsDir } from "../shared/paths.js";
import { addToDenyList, isDenied, updateSkillCapabilities } from "./approval-files.js";
import type { SkillMap } from "./skill-map.js";

export interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface HookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}

export interface RequireApprovalResult {
  requireApproval: {
    title: string;
    description: string;
    severity: "info" | "warning" | "error" | "critical";
    timeoutMs: number;
    timeoutBehavior: "deny" | "allow";
    onResolution: (decision: string) => Promise<void>;
  };
}

export type ApprovalGateResult =
  | RequireApprovalResult
  | { block?: boolean; blockReason?: string }
  | undefined;

export function createApprovalGateHandler(deps: {
  skillMap: SkillMap;
  pluginDir: string;
  pendingViolations: Map<string, SandboxViolation>;
}) {
  return async function approvalGate(event: BeforeToolCallEvent, _ctx: HookContext): Promise<ApprovalGateResult> {
    const toolName = event.toolName;
    const skill = deps.skillMap.getSkill(toolName);
    if (!skill) return undefined;

    const lastResult = typeof event.params?._lastResult === "string" ? event.params._lastResult : "";
    const violationIdMatch = lastResult.match(/\[sc-violation-id:([a-z0-9]+)\]/);
    const violationId = violationIdMatch?.[1];
    const violationKey = violationId
      ? `${skill}:${toolName}:${violationId}`
      : [...deps.pendingViolations.keys()].find((k) => k.startsWith(`${skill}:${toolName}:`));
    const pendingViolation = violationKey ? deps.pendingViolations.get(violationKey) : undefined;

    if (pendingViolation && violationKey) {
      deps.pendingViolations.delete(violationKey);

      if (isDenied(skill, pendingViolation)) {
        return {
          block: true,
          blockReason: `Blocked: ${pendingViolation.type} access to "${pendingViolation.target}" was previously denied for skill "${skill}".`,
        };
      }

      const capturedViolation = pendingViolation;
      let description: string;
      if (pendingViolation.type === "network") {
        description = [
          `Skill "${skill}" tried to reach: ${pendingViolation.target}`,
          `Reason: ${pendingViolation.detail}`,
          "",
          "Options:",
          `• "allow" — allow this specific host (${pendingViolation.target})`,
          `• "allow-all" — allow all outbound network for this skill (for browser/search skills)`,
          `• "deny" — block this once`,
          `• "never" — block this host permanently`,
        ].join("\n");
      } else if (pendingViolation.type === "filesystem") {
        description = [
          `Skill "${skill}" tried to access: ${pendingViolation.target}`,
          `Reason: ${pendingViolation.detail}`,
          "",
          `• "allow" — allow access to this path`,
          `• "deny" — block this once`,
          `• "never" — block this path permanently`,
        ].join("\n");
      } else {
        description = [
          `Skill "${skill}" tried to: ${pendingViolation.target}`,
          `Reason: ${pendingViolation.detail}`,
        ].join("\n");
      }

      return {
        requireApproval: {
          title: `Skill "${skill}" blocked — needs ${pendingViolation.type} access`,
          description,
          severity: "warning",
          timeoutMs: 240_000,
          timeoutBehavior: "deny",
          onResolution: async (decision: string) => {
            const d = decision.toLowerCase().trim();
            if (d === "allow-all" && capturedViolation.type === "network") {
              updateSkillCapabilities(skill, { ...capturedViolation, target: "" });
            } else if (d === "approved" || d === "allow") {
              updateSkillCapabilities(skill, capturedViolation);
            } else if (d === "never") {
              addToDenyList(skill, capturedViolation);
            }
          },
        },
      };
    }

    const approvalPath = resolve(getApprovalsDir(), `${skill}.json`);
    if (existsSync(approvalPath)) return undefined;

    const manifestPath = `${deps.pluginDir}/${skill}/plugin.json`;
    let capabilities: Array<{ capability: string; reason: string; scope?: string[] }> = [];
    let version = "unknown";
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      capabilities = manifest.capabilities ?? [];
      version = manifest.version ?? "unknown";
    } catch {
      // manifest unavailable
    }

    const capDescription = capabilities.length > 0
      ? capabilities.map((c) => `• ${c.capability} — ${c.reason}`).join("\n")
      : "No capabilities declared";

    return {
      requireApproval: {
        title: `Skill "${skill}" requires approval`,
        description: `${capDescription}\n\nVersion: ${version}`,
        severity: "warning",
        timeoutMs: 240_000,
        timeoutBehavior: "deny",
        onResolution: async (decision: string) => {
          if (decision === "approved" || decision === "allow") {
            mkdirSync(getApprovalsDir(), { recursive: true });
            const approval = {
              skill,
              version,
              capabilities,
              approvedAt: new Date().toISOString(),
              approvedVia: "channel",
            };
            writeFileSync(approvalPath, JSON.stringify(approval, null, 2) + "\n");
          }
        },
      },
    };
  };
}
