/** IPC request from OpenClaw plugin to supervisor */
export interface ToolCallRequest {
  id: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
}

/** IPC response from supervisor to OpenClaw plugin */
export interface ToolCallResponse {
  id: string;
  result: string;
  error?: string;
  durationMs: number;
}

/** Approved capabilities for a skill */
export interface SkillApproval {
  skill: string;
  version: string;
  capabilities: SkillCapability[];
  approvedAt: string;
}

export interface SkillCapability {
  capability: string;
  reason: string;
  scope?: string[];
}

/** ASRT sandbox configuration */
export interface AsrtConfig {
  network: {
    allowedDomains: string[];
    allowUnixSockets?: boolean;
  };
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
  };
}

export interface AllowedTarget {
  host: string;
  port: number;
  capability: string;
}

export interface TokenEntry {
  skill: string;
  capabilities: SkillCapability[];
  issuedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface ApprovalRequest {
  type: "approval.request";
  token: string;
  skill: string;
  version: string;
  capabilities: SkillCapability[];
}

export interface ApprovalResponse {
  type: "approval.response";
  token: string;
  approved: boolean;
}

/** Audit log entry */
export interface AuditEntry {
  timestamp: string;
  skill: string;
  tool: string;
  args: string;
  result: string;
  error: string | null;
  durationMs: number;
  blocked: boolean;
  blockReason: string | null;
}
