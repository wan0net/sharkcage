import type { ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { AuditEntry, ToolCallRequest, ToolCallResponse } from "./types.js";
import type { TokenRegistry } from "./proxy.js";

export interface ToolExecutor {
  (
    request: ToolCallRequest,
    approval: NonNullable<ReturnType<ApprovalStore["get"]>>,
    skillDir: string,
    env?: Record<string, string>,
    tokenRegistry?: TokenRegistry
  ): Promise<ToolCallResponse>;
}

export interface SupervisorCoreDeps {
  approvals: ApprovalStore;
  audit: AuditLog;
  execute: ToolExecutor;
  pluginDir: string;
  getSkillEnv: () => Record<string, string>;
  tokenRegistry?: TokenRegistry;
}

export async function recordAuditEntry(audit: AuditLog, entry: AuditEntry): Promise<void> {
  await audit.log({
    ...entry,
    result: entry.result.slice(0, 2000),
  });
}

export async function handleToolCall(
  request: ToolCallRequest,
  deps: SupervisorCoreDeps
): Promise<ToolCallResponse> {
  if (!/^[a-zA-Z0-9_-]+$/.test(request.skill) || !/^[a-zA-Z0-9_-]+$/.test(request.tool)) {
    return {
      id: request.id,
      result: "",
      error: `Invalid skill or tool name: ${request.skill}/${request.tool}`,
      durationMs: 0,
    };
  }

  const timestamp = new Date().toISOString();
  const approval = deps.approvals.get(request.skill);

  if (!approval) {
    const errMsg = `Skill "${request.skill}" is not approved. Approve via your chat channel first.`;
    const response: ToolCallResponse = {
      id: request.id,
      result: "",
      error: errMsg,
      durationMs: 0,
    };

    await recordAuditEntry(deps.audit, {
      timestamp,
      skill: request.skill,
      tool: request.tool,
      args: JSON.stringify(request.args),
      result: "",
      error: errMsg,
      durationMs: 0,
      blocked: true,
      blockReason: "not approved",
      source: "supervised",
    });

    return response;
  }

  const skillPath = `${deps.pluginDir}/${request.skill}`;
  const env = deps.getSkillEnv();
  const response = await deps.execute(request, approval, skillPath, env, deps.tokenRegistry);

  await recordAuditEntry(deps.audit, {
    timestamp,
    skill: request.skill,
    tool: request.tool,
    args: JSON.stringify(request.args),
    result: response.result.slice(0, 2000),
    error: response.error ?? null,
    durationMs: response.durationMs,
    blocked: Boolean(response.violation),
    blockReason: response.violation ? `${response.violation.type}:${response.violation.target}` : null,
    source: "supervised",
  });

  return response;
}
