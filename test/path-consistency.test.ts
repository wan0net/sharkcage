import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApprovalsDir, getAuditLogPath, getConfigDir, getDataDir, getPluginDir } from "../src/shared/paths.ts";
import { getApprovalsDir as getCliApprovalsDir, getAuditLogPath as getCliAuditLogPath } from "../src/cli/lib/paths.ts";
import { listSkills } from "../src/supervisor/api.ts";
import { getAuditEntries } from "../src/supervisor/audit-reader.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

test("shared and CLI path helpers resolve the same control-plane locations", () => {
  const env = createTestEnv();
  try {
    assert.equal(getCliApprovalsDir(), getApprovalsDir());
    assert.equal(getCliAuditLogPath(), getAuditLogPath());
    assert.equal(getConfigDir(), join(process.env.SHARKCAGE_DIR!, "etc"));
    assert.equal(getDataDir(), join(process.env.SHARKCAGE_DIR!, "var"));
  } finally {
    env.restore();
  }
});

test("dashboard-facing readers use the shared runtime paths for approvals and audit data", () => {
  const env = createTestEnv();
  try {
    mkdirSync(getPluginDir(), { recursive: true });
    mkdirSync(getApprovalsDir(), { recursive: true });

    const skillDir = join(getPluginDir(), "meals");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "plugin.json"), JSON.stringify({
      name: "meals",
      version: "1.0.0",
      description: "Meal planning",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
    }));

    writeFileSync(join(getApprovalsDir(), "meals.json"), JSON.stringify({
      skill: "meals",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }));

    writeFileSync(getAuditLogPath(), [
      JSON.stringify({
        timestamp: "2026-04-01T00:00:00.000Z",
        skill: "meals",
        tool: "lookup_dinner",
        args: "{\"day\":\"monday\"}",
        result: "ok",
        error: null,
        durationMs: 12,
        blocked: false,
        blockReason: null,
      }),
    ].join("\n") + "\n");

    const skills = listSkills(getPluginDir(), getApprovalsDir());
    assert.equal(skills.length, 1);
    assert.deepEqual(skills[0], {
      name: "meals",
      version: "1.0.0",
      description: "Meal planning",
      capabilities: 1,
      approved: true,
      approvedAt: "2026-04-01T00:00:00.000Z",
    });

    const audit = getAuditEntries(getAuditLogPath(), 10, null, false);
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0], {
      timestamp: "2026-04-01T00:00:00.000Z",
      skill: "meals",
      tool: "lookup_dinner",
      error: null,
      durationMs: 12,
      blocked: false,
      blockReason: null,
    });
  } finally {
    env.restore();
  }
});
