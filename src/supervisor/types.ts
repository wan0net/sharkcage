import { homedir } from "node:os";

const HOME = homedir();

/**
 * Paths that are ALWAYS denied regardless of capabilities or session config.
 * Canonical list — imported by sandbox.ts and asrt-backend.ts.
 */
export const MANDATORY_DENY_READ: string[] = [
  // Credentials & keys
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gnupg`,
  `${HOME}/.netrc`,
  `${HOME}/.npmrc`,
  `${HOME}/.docker`,
  `${HOME}/.kube`,
  `${HOME}/.config/gh`,
  `${HOME}/.config/gcloud`,
  `${HOME}/.config/op`,
  `${HOME}/.password-store`,
  // Shell configs (can leak env vars / secrets)
  `${HOME}/.bashrc`,
  `${HOME}/.zshrc`,
  `${HOME}/.bash_profile`,
  `${HOME}/.zprofile`,
  `${HOME}/.profile`,
  `${HOME}/.bash_history`,
  `${HOME}/.zsh_history`,
  `${HOME}/.gitconfig`,
  // Sharkcage — AI doesn't need to read the security implementation
  `${HOME}/.sharkcage`,
  `${HOME}/.config/sharkcage`,
];

/** IPC request from OpenClaw plugin to supervisor */
export interface ToolCallRequest {
  id: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AuditRecordRequest {
  id: string;
  type: "audit_record";
  entry: AuditEntry;
}

/** A sandbox policy violation detected from subprocess stderr */
export interface SandboxViolation {
  type: "network" | "filesystem" | "exec";
  target: string; // hostname, file path, or binary name
  detail: string; // raw error message
}

/** IPC response from supervisor to OpenClaw plugin */
export interface ToolCallResponse {
  id: string;
  result: string;
  error?: string;
  durationMs: number;
  violation?: SandboxViolation;
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
    deniedDomains: string[];
    allowLocalBinding?: boolean;
    allowUnixSockets: string[];
  };
  filesystem: {
    allowRead?: string[];
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
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
  source?: "supervised" | "openclaw-direct";
}

export interface AuditRecordResponse {
  id: string;
  ok: true;
}
