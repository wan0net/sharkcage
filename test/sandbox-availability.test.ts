import test from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxStartupDecision } from "../src/supervisor/startup.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

test("startup stays in secure mode when srt is available", () => {
  const env = createTestEnv();
  try {
    const decision = resolveSandboxStartupDecision(true);
    assert.deepEqual(decision, { allowed: true, mode: "secure" });
  } finally {
    env.restore();
  }
});

test("startup fails closed when srt is unavailable and insecure mode is not allowed", () => {
  const env = createTestEnv();
  try {
    const decision = resolveSandboxStartupDecision(false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.mode, "insecure");
    assert.match(decision.message ?? "", /refusing to start without kernel sandbox/i);
  } finally {
    env.restore();
  }
});

test("startup can enter explicit insecure mode only when opted in", () => {
  const env = createTestEnv();
  try {
    process.env.SHARKCAGE_ALLOW_INSECURE = "1";
    const decision = resolveSandboxStartupDecision(false);
    assert.equal(decision.allowed, true);
    assert.equal(decision.mode, "insecure");
    assert.match(decision.message ?? "", /explicitly allowed insecure mode/i);
  } finally {
    env.restore();
  }
});
