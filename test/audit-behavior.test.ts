import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { AuditLog } from "../src/supervisor/audit.ts";
import { getAuditEntries, getAuditIntegritySummary, getAuditStats } from "../src/supervisor/audit-reader.ts";
import { getAuditLogPath, getDataDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

test("audit log records allowed, blocked, and errored tool calls consistently", async () => {
  const env = createTestEnv();
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    await audit.log({
      timestamp: "2026-04-01T00:00:00.000Z",
      skill: "meals",
      tool: "lookup_dinner",
      args: "{\"day\":\"monday\"}",
      result: "ok",
      error: null,
      durationMs: 10,
      blocked: false,
      blockReason: null,
    });
    await audit.log({
      timestamp: "2026-04-01T00:00:01.000Z",
      skill: "meals",
      tool: "lookup_dinner",
      args: "{\"day\":\"tuesday\"}",
      result: "",
      error: null,
      durationMs: 4,
      blocked: true,
      blockReason: "not approved",
    });
    await audit.log({
      timestamp: "2026-04-01T00:00:02.000Z",
      skill: "meals",
      tool: "lookup_dinner",
      args: "{\"day\":\"wednesday\"}",
      result: "",
      error: "upstream failed",
      durationMs: 7,
      blocked: false,
      blockReason: null,
    });

    const entries = getAuditEntries(getAuditLogPath(), 10, "meals", false);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => ({ blocked: entry.blocked, error: entry.error })), [
      { blocked: false, error: null },
      { blocked: true, error: null },
      { blocked: false, error: "upstream failed" },
    ]);

    const stats = getAuditStats(getAuditLogPath()) as {
      total: number;
      blocked: number;
      errors: number;
      ok: number;
      bySkill: Record<string, { calls: number; blocked: number }>;
      integrity: { checked: number; broken: number; lastSeq: number };
    };
    assert.equal(stats.total, 3);
    assert.equal(stats.blocked, 1);
    assert.equal(stats.errors, 1);
    assert.equal(stats.ok, 1);
    assert.deepEqual(stats.bySkill.meals, { calls: 3, blocked: 1 });
    assert.equal(stats.integrity.checked, 3);
    assert.equal(stats.integrity.broken, 0);
  } finally {
    env.restore();
  }
});

test("audit log rotates and readers include rotated archives", async () => {
  const env = createTestEnv();
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const audit = new AuditLog(getAuditLogPath(), { maxBytes: 350, maxArchives: 10 });
    await audit.open();

    for (let i = 0; i < 6; i++) {
      await audit.log({
        timestamp: `2026-04-01T00:00:0${i}.000Z`,
        skill: "meals",
        tool: `lookup_${i}`,
        args: JSON.stringify({ index: i, payload: "x".repeat(40) }),
        result: "ok",
        error: null,
        durationMs: 10 + i,
        blocked: false,
        blockReason: null,
      });
    }

    const files = readdirSync(getDataDir()).filter((name) => name.startsWith("audit.jsonl"));
    assert.ok(files.length >= 2);

    const entries = getAuditEntries(getAuditLogPath(), 20, null, false);
    assert.equal(entries.length, 6);
    assert.equal(entries.at(-1)?.tool, "lookup_5");
  } finally {
    env.restore();
  }
});

test("audit log writes a linked hash chain that can be checked", async () => {
  const env = createTestEnv();
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const audit = new AuditLog(getAuditLogPath());
    await audit.open();

    await audit.log({
      timestamp: "2026-04-01T00:00:00.000Z",
      skill: "meals",
      tool: "first",
      args: "{}",
      result: "ok",
      error: null,
      durationMs: 1,
      blocked: false,
      blockReason: null,
    });
    await audit.log({
      timestamp: "2026-04-01T00:00:01.000Z",
      skill: "meals",
      tool: "second",
      args: "{}",
      result: "ok",
      error: null,
      durationMs: 1,
      blocked: false,
      blockReason: null,
    });

    const lines = readFileSync(getAuditLogPath(), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[0].prevHash, null);
    assert.equal(lines[1].seq, 2);
    assert.equal(lines[1].prevHash, lines[0].entryHash);

    const integrity = getAuditIntegritySummary(getAuditLogPath());
    assert.deepEqual(integrity, { checked: 2, broken: 0, lastSeq: 2 });
  } finally {
    env.restore();
  }
});
