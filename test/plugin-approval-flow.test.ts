import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApprovalGateHandler } from "../src/plugin/approval-gate.ts";
import { SkillMap } from "../src/plugin/skill-map.ts";
import { getApprovalsDir, getDeniedDir, getPluginDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";
import type { SandboxViolation } from "../src/supervisor/types.ts";

function seedSkill(): SkillMap {
  mkdirSync(getPluginDir(), { recursive: true });
  const skillDir = join(getPluginDir(), "fixture_skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "plugin.json"), JSON.stringify({
    name: "fixture_skill",
    version: "1.0.0",
    tools: ["fixture_echo"],
    capabilities: [
      { capability: "network.external", reason: "API access", scope: ["api.example.com"] },
      { capability: "system.files.write", reason: "Write reports", scope: ["/tmp/reports"] },
    ],
  }) + "\n");

  const skillMap = new SkillMap();
  skillMap.load(getPluginDir());
  return skillMap;
}

test("plugin approval gate prompts for first-use approval and writes approval on allow", async () => {
  const env = createTestEnv();
  try {
    const skillMap = seedSkill();
    const pendingViolations = new Map();
    const handler = createApprovalGateHandler({ skillMap, pluginDir: getPluginDir(), pendingViolations });

    const result = await handler({ toolName: "fixture_echo" }, {});
    assert.ok(result && "requireApproval" in result);
    assert.match(result.requireApproval.title, /requires approval/);
    assert.match(result.requireApproval.description, /network\.external/);

    await result.requireApproval.onResolution("allow");

    const approval = JSON.parse(readFileSync(join(getApprovalsDir(), "fixture_skill.json"), "utf-8")) as {
      skill: string;
      version: string;
      approvedVia: string;
      capabilities: Array<{ capability: string }>;
    };
    assert.equal(approval.skill, "fixture_skill");
    assert.equal(approval.version, "1.0.0");
    assert.equal(approval.approvedVia, "channel");
    assert.deepEqual(approval.capabilities.map((cap) => cap.capability), ["network.external", "system.files.write"]);
  } finally {
    env.restore();
  }
});

test("plugin approval gate expands runtime network scope on allow", async () => {
  const env = createTestEnv();
  try {
    const skillMap = seedSkill();
    mkdirSync(getApprovalsDir(), { recursive: true });
    writeFileSync(join(getApprovalsDir(), "fixture_skill.json"), JSON.stringify({
      skill: "fixture_skill",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const pendingViolations = new Map<string, SandboxViolation>([
      ["fixture_skill:fixture_echo:abc12345", {
        type: "network",
        target: "search.example.com",
        detail: "ENOTFOUND search.example.com",
      }],
    ]);

    const handler = createApprovalGateHandler({ skillMap, pluginDir: getPluginDir(), pendingViolations });
    const result = await handler({
      toolName: "fixture_echo",
      params: { _lastResult: "Requesting approval... [sc-violation-id:abc12345]" },
    }, {});

    assert.ok(result && "requireApproval" in result);
    assert.match(result.requireApproval.title, /needs network access/);

    await result.requireApproval.onResolution("allow");

    const approval = JSON.parse(readFileSync(join(getApprovalsDir(), "fixture_skill.json"), "utf-8")) as {
      capabilities: Array<{ capability: string; scope?: string[] }>;
    };
    assert.deepEqual(approval.capabilities[0].scope, ["api.example.com", "search.example.com"]);
  } finally {
    env.restore();
  }
});

test("plugin approval gate records permanent deny and blocks the next matching violation", async () => {
  const env = createTestEnv();
  try {
    const skillMap = seedSkill();
    mkdirSync(getApprovalsDir(), { recursive: true });
    writeFileSync(join(getApprovalsDir(), "fixture_skill.json"), JSON.stringify({
      skill: "fixture_skill",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const firstPending = new Map<string, SandboxViolation>([
      ["fixture_skill:fixture_echo:def67890", {
        type: "network",
        target: "blocked.example.com",
        detail: "ENOTFOUND blocked.example.com",
      }],
    ]);
    const handler = createApprovalGateHandler({ skillMap, pluginDir: getPluginDir(), pendingViolations: firstPending });

    const first = await handler({
      toolName: "fixture_echo",
      params: { _lastResult: "Requesting approval... [sc-violation-id:def67890]" },
    }, {});
    assert.ok(first && "requireApproval" in first);

    await first.requireApproval.onResolution("never");

    const denyList = JSON.parse(readFileSync(join(getDeniedDir(), "fixture_skill.json"), "utf-8")) as {
      denied: Array<{ type: string; target: string }>;
    };
    assert.deepEqual(denyList.denied.map((entry) => `${entry.type}:${entry.target}`), ["network:blocked.example.com"]);

    const secondPending = new Map<string, SandboxViolation>([
      ["fixture_skill:fixture_echo:zzz11111", {
        type: "network",
        target: "blocked.example.com",
        detail: "ENOTFOUND blocked.example.com",
      }],
    ]);
    const secondHandler = createApprovalGateHandler({ skillMap, pluginDir: getPluginDir(), pendingViolations: secondPending });
    const second = await secondHandler({
      toolName: "fixture_echo",
      params: { _lastResult: "Requesting approval... [sc-violation-id:zzz11111]" },
    }, {});

    assert.deepEqual(second, {
      block: true,
      blockReason: 'Blocked: network access to "blocked.example.com" was previously denied for skill "fixture_skill".',
    });
  } finally {
    env.restore();
  }
});
