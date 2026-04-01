import test from "node:test";
import assert from "node:assert/strict";
import { TokenRegistry, buildAllowedTargets, checkTarget } from "../src/supervisor/proxy.ts";
import type { SkillCapability } from "../src/supervisor/types.ts";

test("token registry issues, resolves, and revokes skill tokens", () => {
  const registry = new TokenRegistry();
  const capabilities: SkillCapability[] = [
    { capability: "network.external", reason: "Call API", scope: ["api.example.com:443"] },
  ];

  const token = registry.issue("fixture_skill", capabilities);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(registry.lookup(token), {
    skill: "fixture_skill",
    capabilities,
  });

  registry.revoke(token);
  assert.equal(registry.lookup(token), null);
});

test("proxy allowlist is derived from approved capabilities and service env", () => {
  const allowed = buildAllowedTargets([
    { capability: "home.read", reason: "Read Home Assistant" },
    { capability: "fleet.read", reason: "Read Nomad" },
    { capability: "network.external", reason: "Call external APIs", scope: ["api.example.com:8443"] },
    { capability: "network.internal", reason: "Reach internal services", scope: ["db.internal:5432"] },
  ], {
    HA_URL: "https://ha.example.net:9443",
    NOMAD_ADDR: "http://nomad.service.consul:4647",
  });

  assert.deepEqual(allowed, [
    { host: "127.0.0.1", port: 18800, capability: "internal" },
    { host: "ha.example.net", port: 9443, capability: "home.read" },
    { host: "nomad.service.consul", port: 4647, capability: "fleet.read" },
    { host: "api.example.com", port: 8443, capability: "network.external" },
    { host: "db.internal", port: 5432, capability: "network.internal" },
  ]);
});

test("proxy target checks allow approved hosts and deny supervisor ports even with wildcard access", () => {
  const allowed = buildAllowedTargets([
    { capability: "network.internal", reason: "Reach internal systems" },
    { capability: "network.external", reason: "Reach any external API", scope: ["api.example.com"] },
  ], {});

  assert.deepEqual(checkTarget(allowed, "api.example.com", 443), {
    allowed: true,
    capability: "network.external",
  });
  assert.deepEqual(checkTarget(allowed, "localhost", 18790), {
    allowed: false,
    reason: "supervisor ports blocked",
  });
  assert.deepEqual(checkTarget(allowed, "::1", 18800), {
    allowed: false,
    reason: "supervisor ports blocked",
  });
  assert.deepEqual(checkTarget(allowed, "cache.internal", 6379), {
    allowed: true,
    capability: "network.internal",
  });
});
