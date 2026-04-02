import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AuditLog } from "../src/supervisor/audit.ts";
import { recordAuditEntry } from "../src/supervisor/core.ts";
import { buildDirectToolAuditEntry } from "../src/plugin/direct-audit.ts";
import { getAuditEntries } from "../src/supervisor/audit-reader.ts";
import { getAuditLogPath } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

test("direct OpenClaw tool calls can be recorded in the structured audit log", async () => {
  const env = createTestEnv();
  try {
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    await recordAuditEntry(audit, buildDirectToolAuditEntry({
      toolName: "web_search",
      params: { query: "sharkcage" },
      result: { ok: true },
      durationMs: 42,
    }));

    const entries = getAuditEntries(getAuditLogPath(), 10, "openclaw", false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, "web_search");
    assert.equal(entries[0].blocked, false);

    const raw = readFileSync(getAuditLogPath(), "utf-8").trim().split("\n");
    const payload = JSON.parse(raw[0]).payload as { source?: string };
    assert.equal(payload.source, "openclaw-direct");
  } finally {
    env.restore();
  }
});

test("direct OpenClaw blocked tool calls preserve blocked metadata in the audit log", async () => {
  const env = createTestEnv();
  try {
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    await recordAuditEntry(audit, buildDirectToolAuditEntry({
      toolName: "bash",
      params: { command: "cat ~/.ssh/id_rsa" },
      error: "Blocked: access to sensitive file (/Users/test/.ssh/id_rsa)",
      blocked: true,
      blockReason: "security:sensitive-file:/Users/test/.ssh/id_rsa",
    }));

    const entries = getAuditEntries(getAuditLogPath(), 10, "openclaw", true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, "bash");
    assert.equal(entries[0].blocked, true);
    assert.equal(entries[0].blockReason, "security:sensitive-file:/Users/test/.ssh/id_rsa");
  } finally {
    env.restore();
  }
});
