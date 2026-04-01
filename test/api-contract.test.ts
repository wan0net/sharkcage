import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleDashboardApiRequest } from "../src/supervisor/api.ts";
import { getApprovalsDir, getAuditLogPath, getConfigDir, getPluginDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

function seedApiFixture(): void {
  mkdirSync(getPluginDir(), { recursive: true });
  mkdirSync(getApprovalsDir(), { recursive: true });

  const skillDir = join(getPluginDir(), "fixture_skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "plugin.json"), JSON.stringify({
    name: "fixture_skill",
    version: "1.0.0",
    description: "Fixture skill",
    capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
  }) + "\n");

  writeFileSync(join(getApprovalsDir(), "fixture_skill.json"), JSON.stringify({
    skill: "fixture_skill",
    version: "1.0.0",
    capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
    approvedAt: "2026-04-01T00:00:00.000Z",
  }) + "\n");

  writeFileSync(getAuditLogPath(), [
    JSON.stringify({
      timestamp: "2026-04-01T00:00:00.000Z",
      skill: "fixture_skill",
      tool: "echo",
      args: "{\"value\":42}",
      result: "{\"ok\":true}",
      error: null,
      durationMs: 15,
      blocked: false,
      blockReason: null,
    }),
    JSON.stringify({
      timestamp: "2026-04-01T00:01:00.000Z",
      skill: "fixture_skill",
      tool: "violate_network",
      args: "{}",
      result: "",
      error: "ENOTFOUND blocked.example.com",
      durationMs: 12,
      blocked: true,
      blockReason: "network:blocked.example.com",
    }),
  ].join("\n") + "\n");
}

test("API contract returns expected status summary", () => {
  const env = createTestEnv();
  try {
    seedApiFixture();
    const result = handleDashboardApiRequest("GET", "/api/status", {
      configDir: getConfigDir(),
      pluginDir: getPluginDir(),
      approvalsDir: getApprovalsDir(),
      auditPath: getAuditLogPath(),
      hasAsrt: true,
      auditHealth: {
        healthy: false,
        lastWriteError: "disk full",
        lastWriteAt: "2026-04-01T00:02:00.000Z",
      },
    });

    assert.equal(result.status, 200);
    const body = result.body as {
      status: string;
      asrt: boolean;
      skills: number;
      approvedSkills: number;
      audit: { healthy: boolean; lastWriteError: string | null; lastWriteAt: string | null };
    };
    assert.equal(body.status, "running");
    assert.equal(body.asrt, true);
    assert.equal(body.skills, 1);
    assert.equal(body.approvedSkills, 1);
    assert.deepEqual(body.audit, {
      healthy: false,
      lastWriteError: "disk full",
      lastWriteAt: "2026-04-01T00:02:00.000Z",
    });
  } finally {
    env.restore();
  }
});

test("API contract returns skill detail and rejects invalid names", () => {
  const env = createTestEnv();
  try {
    seedApiFixture();
    const ok = handleDashboardApiRequest("GET", "/api/skills/fixture_skill", {
      configDir: getConfigDir(),
      pluginDir: getPluginDir(),
      approvalsDir: getApprovalsDir(),
      auditPath: getAuditLogPath(),
      hasAsrt: true,
    });
    assert.equal(ok.status, 200);
    const okBody = ok.body as { name: string; manifest: { version: string }; approval: { approvedAt: string } };
    assert.equal(okBody.name, "fixture_skill");
    assert.equal(okBody.manifest.version, "1.0.0");
    assert.equal(okBody.approval.approvedAt, "2026-04-01T00:00:00.000Z");

    const bad = handleDashboardApiRequest("GET", "/api/skills/fixture.skill", {
      configDir: getConfigDir(),
      pluginDir: getPluginDir(),
      approvalsDir: getApprovalsDir(),
      auditPath: getAuditLogPath(),
      hasAsrt: true,
    });
    assert.equal(bad.status, 400);
  } finally {
    env.restore();
  }
});

test("API contract returns filtered audit entries and stats", () => {
  const env = createTestEnv();
  try {
    seedApiFixture();
    const entries = handleDashboardApiRequest("GET", "/api/audit?tail=10&blocked=true", {
      configDir: getConfigDir(),
      pluginDir: getPluginDir(),
      approvalsDir: getApprovalsDir(),
      auditPath: getAuditLogPath(),
      hasAsrt: true,
    });
    assert.equal(entries.status, 200);
    const entryBody = entries.body as Array<{ tool: string; blocked: boolean }>;
    assert.equal(entryBody.length, 1);
    assert.deepEqual(entryBody[0], { tool: "violate_network", blocked: true, timestamp: "2026-04-01T00:01:00.000Z", skill: "fixture_skill", error: "ENOTFOUND blocked.example.com", durationMs: 12, blockReason: "network:blocked.example.com" });

    const stats = handleDashboardApiRequest("GET", "/api/audit/stats", {
      configDir: getConfigDir(),
      pluginDir: getPluginDir(),
      approvalsDir: getApprovalsDir(),
      auditPath: getAuditLogPath(),
      hasAsrt: true,
    });
    assert.equal(stats.status, 200);
    const statsBody = stats.body as { total: number; blocked: number; errors: number; ok: number };
    assert.deepEqual(statsBody.total, 2);
    assert.deepEqual(statsBody.blocked, 1);
    assert.deepEqual(statsBody.errors, 0);
    assert.deepEqual(statsBody.ok, 1);
  } finally {
    env.restore();
  }
});
