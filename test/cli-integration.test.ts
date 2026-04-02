import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getApprovalsDir, getAuditLogPath, getGatewayConfigPath, getPluginDir } from "../src/shared/paths.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

async function runCli(args: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

test("CLI audit command renders filtered audit output from shared audit log", async () => {
  const env = createTestEnv();
  try {
    mkdirSync(join(process.env.SHARKCAGE_DIR!, "var"), { recursive: true });
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

    const result = await runCli(["audit", "--blocked", "--tail", "5"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Audit log: 1 entries/);
    assert.match(result.stdout, /fixture_skill\/violate_network/);
    assert.match(result.stdout, /Reason: network:blocked\.example\.com/);
    assert.match(result.stdout, /Summary: 0 ok, 0 errors, 1 blocked/);
  } finally {
    env.restore();
  }
});

test("CLI approve command writes approval file for an installed skill", async () => {
  const env = createTestEnv();
  try {
    const skillDir = join(getPluginDir(), "fixture_skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "plugin.json"), JSON.stringify({
      name: "fixture_skill",
      version: "1.0.0",
      capabilities: [
        { capability: "network.external", reason: "API access", scope: ["api.example.com"] },
        { capability: "system.files.write", reason: "Write reports", scope: ["/tmp/reports"] },
      ],
    }) + "\n");

    const result = await runCli(["approve", "fixture_skill"], "\n");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Skill: fixture_skill v1\.0\.0/);
    assert.match(result.stdout, /Approved\./);

    const approval = JSON.parse(readFileSync(join(getApprovalsDir(), "fixture_skill.json"), "utf-8")) as {
      skill: string;
      version: string;
      capabilities: Array<{ capability: string }>;
    };
    assert.equal(approval.skill, "fixture_skill");
    assert.equal(approval.version, "1.0.0");
    assert.deepEqual(approval.capabilities.map((cap) => cap.capability), ["network.external", "system.files.write"]);
  } finally {
    env.restore();
  }
});

test("CLI skill add installs a local skill and skill list reports pending approval", async () => {
  const env = createTestEnv();
  try {
    const sourceSkillDir = join(env.root, "fixture-source-skill");
    mkdirSync(sourceSkillDir, { recursive: true });
    writeFileSync(join(sourceSkillDir, "plugin.json"), JSON.stringify({
      name: "fixture_skill",
      type: "plugin",
      version: "1.2.0",
      description: "Local fixture skill",
      main: "mod.js",
      capabilities: [
        { capability: "network.external", reason: "API access", scope: ["api.example.com"] },
      ],
    }) + "\n");
    writeFileSync(join(sourceSkillDir, "mod.js"), "export const definitions = [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: {} } } }];\nexport async function execute() { return { ok: true }; }\nexport default { definitions, execute };\n");

    const addResult = await runCli(["skill", "add", sourceSkillDir]);
    assert.equal(addResult.code, 0);
    assert.match(addResult.stdout, /Installed: fixture_skill/);
    assert.match(addResult.stdout, /Capabilities will be approved on first use via chat channel\./);

    const linkedPath = join(getPluginDir(), "fixture_skill");
    const listResult = await runCli(["skill", "list"]);
    assert.equal(listResult.code, 0);
    assert.match(listResult.stdout, /fixture_skill v1\.2\.0 \[pending\]/);
    assert.match(listResult.stdout, /1 capabilities, needs approval/);

    const approvalPath = join(getApprovalsDir(), "fixture_skill.json");
    assert.equal(readFileSync(join(linkedPath, "plugin.json"), "utf-8").includes("\"fixture_skill\""), true);
    assert.equal(lstatSync(linkedPath).isSymbolicLink(), true);
    assert.equal(existsSync(approvalPath), false);
  } finally {
    env.restore();
  }
});

test("CLI status reports not running when no pid file is present", async () => {
  const env = createTestEnv();
  try {
    const result = await runCli(["status"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /sharkcage status/);
    assert.match(result.stdout, /sharkcage is not running/);
  } finally {
    env.restore();
  }
});

test("CLI init supports non-interactive setup when OpenClaw is already configured", async () => {
  const env = createTestEnv();
  try {
    const installDir = process.env.SHARKCAGE_DIR!;
    mkdirSync(join(installDir, ".openclaw"), { recursive: true });

    writeFileSync(join(installDir, "etc", "install.json"), JSON.stringify({
      installDir,
      openclawBin: join(installDir, "node_modules/.bin/openclaw"),
      srtBin: join(installDir, "node_modules/.bin/srt"),
      scBin: join(installDir, "bin/sc"),
      installedBy: "tester",
      version: "1.2.0",
      installedAt: "2026-04-01T00:00:00.000Z",
    }) + "\n");

    writeFileSync(join(installDir, ".openclaw", "openclaw.json"), JSON.stringify({
      gateway: { mode: "local" },
      agents: { defaults: { model: "openrouter/auto" } },
    }) + "\n");

    const result = await runCli(["init", "--non-interactive", "--mode", "full", "--no-service-user"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OpenClaw already configured\./);
    assert.match(result.stdout, /Config written to/);
    assert.match(result.stdout, /Setup complete/);

    const gatewayConfig = JSON.parse(readFileSync(getGatewayConfigPath(), "utf-8")) as {
      mode: string;
      runAsUser?: string;
    };
    assert.equal(gatewayConfig.mode, "full");
    assert.equal(gatewayConfig.runAsUser, undefined);
  } finally {
    env.restore();
  }
});
