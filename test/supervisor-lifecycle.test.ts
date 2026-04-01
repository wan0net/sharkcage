import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ApprovalStore } from "../src/supervisor/approvals.ts";
import { AuditLog } from "../src/supervisor/audit.ts";
import { handleToolCall, type ToolExecutor } from "../src/supervisor/core.ts";
import { getApprovalsDir, getAuditLogPath, getPluginDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";
import type { ToolCallRequest, ToolCallResponse } from "../src/supervisor/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureSourceDir = join(__dirname, "fixtures", "supervisor-skill");

function installFixtureSkill(): void {
  const targetDir = join(getPluginDir(), "fixture_skill");
  mkdirSync(getPluginDir(), { recursive: true });
  cpSync(fixtureSourceDir, targetDir, { recursive: true });
}

const executeFixtureSkill: ToolExecutor = async (
  request,
  _approval,
  skillDir
): Promise<ToolCallResponse> => {
  const start = Date.now();
  const child = spawn(process.execPath, [join(skillDir, "mod.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      SHARKCAGE_TOOL_CALL: "1",
    },
  });

  child.stdin.write(JSON.stringify({ tool: request.tool, args: request.args }));
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    return {
      id: request.id,
      result: "",
      error: `Skill exited with code ${exitCode}: ${stderr}`,
      durationMs: Date.now() - start,
      violation: request.tool === "violate_network"
        ? { type: "network", target: "blocked.example.com", detail: stderr }
        : undefined,
    };
  }

  return {
    id: request.id,
    result: stdout,
    durationMs: Date.now() - start,
  };
};

function createRequest(tool: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return {
    id: `req_${tool}`,
    skill: "fixture_skill",
    tool,
    args,
  };
}

function readAuditPayload(path: string): Array<{ blocked: boolean; blockReason: string | null; error: string | null; tool: string }> {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).payload);
}

test("supervisor lifecycle blocks unapproved skills and audits the denial", async () => {
  const env = createTestEnv();
  try {
    installFixtureSkill();
    mkdirSync(dirname(getAuditLogPath()), { recursive: true });
    const approvals = new ApprovalStore(getApprovalsDir());
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    const response = await handleToolCall(createRequest("echo", { value: 1 }), {
      approvals,
      audit,
      execute: executeFixtureSkill,
      pluginDir: getPluginDir(),
      getSkillEnv: () => ({}),
    });

    assert.match(response.error ?? "", /not approved/i);

    const lines = readAuditPayload(getAuditLogPath());
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.blocked, true);
    assert.equal(entry.blockReason, "not approved");
    assert.equal(entry.tool, "echo");
  } finally {
    env.restore();
  }
});

test("supervisor lifecycle executes approved skills and audits success", async () => {
  const env = createTestEnv();
  try {
    installFixtureSkill();
    mkdirSync(getApprovalsDir(), { recursive: true });
    writeFileSync(join(getApprovalsDir(), "fixture_skill.json"), JSON.stringify({
      skill: "fixture_skill",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "Test capability", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const approvals = new ApprovalStore(getApprovalsDir());
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    const response = await handleToolCall(createRequest("echo", { value: 42 }), {
      approvals,
      audit,
      execute: executeFixtureSkill,
      pluginDir: getPluginDir(),
      getSkillEnv: () => ({}),
    });

    const result = JSON.parse(response.result) as { args: { value: number }; envFlag: string };
    assert.equal(result.args.value, 42);
    assert.equal(result.envFlag, "1");

    const lines = readAuditPayload(getAuditLogPath());
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.blocked, false);
    assert.equal(entry.error, null);
    assert.equal(entry.tool, "echo");
  } finally {
    env.restore();
  }
});

test("supervisor lifecycle records sandbox-style violations as blocked audit events", async () => {
  const env = createTestEnv();
  try {
    installFixtureSkill();
    mkdirSync(getApprovalsDir(), { recursive: true });
    writeFileSync(join(getApprovalsDir(), "fixture_skill.json"), JSON.stringify({
      skill: "fixture_skill",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "Test capability", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const approvals = new ApprovalStore(getApprovalsDir());
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    const response = await handleToolCall(createRequest("violate_network"), {
      approvals,
      audit,
      execute: executeFixtureSkill,
      pluginDir: getPluginDir(),
      getSkillEnv: () => ({}),
    });

    assert.ok(response.violation);
    assert.equal(response.violation?.type, "network");
    assert.equal(response.violation?.target, "blocked.example.com");

    const lines = readAuditPayload(getAuditLogPath());
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.blocked, true);
    assert.equal(entry.blockReason, "network:blocked.example.com");
    assert.match(entry.error ?? "", /blocked\.example\.com/);
  } finally {
    env.restore();
  }
});
