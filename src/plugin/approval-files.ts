import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SandboxViolation } from "../supervisor/types.js";
import { getApprovalsDir, getDeniedDir } from "../shared/paths.js";

interface ApprovalCapability {
  capability: string;
  reason: string;
  scope?: string[];
}

interface SkillApprovalRecord {
  skill: string;
  version?: string;
  capabilities: ApprovalCapability[];
  approvedAt?: string;
  approvedVia?: string;
}

interface DenyListRecord {
  skill: string;
  denied: Array<{ type: string; target: string; deniedAt: string }>;
}

function approvalPath(skill: string): string {
  return resolve(getApprovalsDir(), `${skill}.json`);
}

function denyListPath(skill: string): string {
  return resolve(getDeniedDir(), `${skill}.json`);
}

export function isDenied(skill: string, violation: SandboxViolation): boolean {
  const path = denyListPath(skill);
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as DenyListRecord;
    return data.denied.some((d) => d.type === violation.type && d.target === violation.target);
  } catch {
    return false;
  }
}

export function addToDenyList(skill: string, violation: SandboxViolation): void {
  const dir = getDeniedDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // exists
  }

  const path = denyListPath(skill);
  let data: DenyListRecord = { skill, denied: [] };
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf-8")) as DenyListRecord;
    } catch {
      // overwrite corrupt file with a clean record
    }
  }

  data.denied.push({
    type: violation.type,
    target: violation.target,
    deniedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function updateSkillCapabilities(skill: string, violation: SandboxViolation): boolean {
  const path = approvalPath(skill);
  if (!existsSync(path)) return false;

  try {
    const approval = JSON.parse(readFileSync(path, "utf-8")) as SkillApprovalRecord;
    const capabilities = approval.capabilities ?? [];

    const capabilityName = violation.type === "network"
      ? "network.external"
      : violation.type === "filesystem"
        ? "system.files.write"
        : "system.exec";

    const existing = capabilities.find((c) => c.capability === capabilityName);

    if (!violation.target) {
      if (existing) {
        delete existing.scope;
        existing.reason = "User-approved: unrestricted";
      } else {
        capabilities.push({
          capability: capabilityName,
          reason: "User-approved: unrestricted",
        });
      }
    } else if (existing) {
      if (existing.scope && !existing.scope.includes(violation.target)) {
        existing.scope = [...existing.scope, violation.target];
      }
    } else {
      capabilities.push({
        capability: capabilityName,
        reason: `User-approved at runtime: ${violation.target}`,
        scope: [violation.target],
      });
    }

    approval.capabilities = capabilities;
    writeFileSync(path, JSON.stringify(approval, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
