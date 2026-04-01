import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeInSandbox } from "../src/supervisor/worker.ts";
import { createTestEnv } from "./helpers/tmp-env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureSourceDir = join(__dirname, "fixtures", "supervisor-skill");

test("real worker path can execute the fixture skill when the host supports srt", async (t) => {
  const env = createTestEnv();
  try {
    const pluginDir = join(process.env.SHARKCAGE_DIR!, "var", "plugins", "fixture_skill");
    mkdirSync(join(process.env.SHARKCAGE_DIR!, "var", "plugins"), { recursive: true });
    cpSync(fixtureSourceDir, pluginDir, { recursive: true });

    const approval = {
      skill: "fixture_skill",
      version: "1.0.0",
      capabilities: [{ capability: "network.external", reason: "Test capability", scope: ["api.example.com"] }],
      approvedAt: new Date().toISOString(),
    };

    const response = await executeInSandbox(
      { id: "real-worker", skill: "fixture_skill", tool: "echo", args: { value: 42 } },
      approval,
      pluginDir,
      {}
    );

    if (response.error?.includes("listen EPERM: operation not permitted 127.0.0.1")) {
      t.skip("Host sandbox blocks the localhost bind that srt requires internally");
      return;
    }

    assert.equal(response.error, undefined);
    const result = JSON.parse(response.result) as { args: { value: number } };
    assert.equal(result.args.value, 42);
  } finally {
    env.restore();
  }
});
