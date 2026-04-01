import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalStore } from "../src/supervisor/approvals.ts";
import { addToDenyList, isDenied, updateSkillCapabilities } from "../src/plugin/approval-files.ts";
import { getApprovalsDir, getDeniedDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

test("approval store observes approvals written to the shared approvals directory", () => {
  const env = createTestEnv();
  try {
    mkdirSync(getApprovalsDir(), { recursive: true });
    const store = new ApprovalStore(getApprovalsDir());

    assert.equal(store.get("meals"), null);

    writeFileSync(join(getApprovalsDir(), "meals.json"), JSON.stringify({
      skill: "meals",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const approval = store.get("meals");
    assert.ok(approval);
    assert.equal(approval.version, "1.0.0");
    assert.deepEqual(approval.capabilities[0].scope, ["api.example.com"]);
  } finally {
    env.restore();
  }
});

test("runtime capability expansion updates the correct approval record", () => {
  const env = createTestEnv();
  try {
    mkdirSync(getApprovalsDir(), { recursive: true });
    writeFileSync(join(getApprovalsDir(), "meals.json"), JSON.stringify({
      skill: "meals",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "API access", scope: ["api.example.com"] }],
      approvedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    const updated = updateSkillCapabilities("meals", {
      type: "network",
      target: "search.example.com",
      detail: "ENOTFOUND search.example.com",
    });

    assert.equal(updated, true);

    const store = new ApprovalStore(getApprovalsDir());
    const approval = store.get("meals");
    assert.ok(approval);
    assert.deepEqual(approval.capabilities[0].scope, ["api.example.com", "search.example.com"]);
  } finally {
    env.restore();
  }
});

test("deny list persists and blocks previously denied targets", () => {
  const env = createTestEnv();
  try {
    mkdirSync(getDeniedDir(), { recursive: true });
    const violation = {
      type: "network" as const,
      target: "evil.example.com",
      detail: "ENOTFOUND evil.example.com",
    };

    assert.equal(isDenied("meals", violation), false);
    addToDenyList("meals", violation);
    assert.equal(isDenied("meals", violation), true);
  } finally {
    env.restore();
  }
});
