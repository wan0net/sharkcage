/**
 * sc init
 *
 * 1. Run openclaw onboard (if not already configured) — handles model, API keys, channels
 * 2. Verify the model actually works
 * 3. Choose sharkcage sandbox mode
 * 4. Write sharkcage config
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import * as p from "@clack/prompts";

type Mode = "full" | "skills-only";

interface SharkcageConfig {
  mode: Mode;
  outerSandbox: boolean;
}

const home = process.env.HOME ?? ".";
const configDir = `${home}/.config/sharkcage`;

export default async function init() {
  p.intro("sharkcage — OpenClaw, but you trust it.");

  // --- 1. Check if OpenClaw is configured ---
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
  let needsOnboard = true;

  if (existsSync(ocConfigPath)) {
    try {
      const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
      if (ocConfig.gateway?.mode) {
        needsOnboard = false;
      }
    } catch { /* can't read */ }
  }

  if (needsOnboard) {
    p.note(
      "OpenClaw needs to be set up first.\n" +
      "This wizard will configure your model, API key, channels, and gateway.\n" +
      "After that, sharkcage will wrap it in a sandbox.",
      "OpenClaw Setup"
    );

    const runOnboard = await p.confirm({ message: "Run OpenClaw setup wizard now?" });
    if (p.isCancel(runOnboard) || !runOnboard) {
      p.cancel("Run 'openclaw onboard' manually, then re-run 'sc init'.");
      process.exit(0);
    }

    console.log("");
    console.log("┌──────────────────────────────────────────────┐");
    console.log("│  🦞 OpenClaw Setup (not sharkcage)           │");
    console.log("│  Everything below is OpenClaw's own wizard.  │");
    console.log("│  Sharkcage setup continues after.            │");
    console.log("└──────────────────────────────────────────────┘");
    console.log("");

    const result = spawnSync("openclaw", ["onboard", "--no-install-daemon", "--skip-skills"], {
      stdio: "inherit",
    });

    if (result.status !== 0) {
      p.log.error("OpenClaw setup failed. Fix the issue and re-run 'sc init'.");
      process.exit(1);
    }

    console.log("");
    console.log("┌──────────────────────────────────────────────┐");
    console.log("│  🦈 Back to Sharkcage                        │");
    console.log("└──────────────────────────────────────────────┘");
    console.log("");
  } else {
    p.log.success("OpenClaw already configured.");
  }

  // --- 2. Verify model ---
  try {
    const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    const model = ocConfig.agents?.defaults?.model;
    const modelStr = typeof model === "string" ? model : model?.primary ?? "unknown";
    p.log.info(`Model: ${modelStr}`);

    // Quick check: is the model available?
    try {
      const listOutput = execFileSync("openclaw", ["models", "list"], {
        encoding: "utf-8", timeout: 15_000, stdio: "pipe",
      });
      if (listOutput.includes(modelStr) && listOutput.includes("missing")) {
        p.log.warning(`Model "${modelStr}" shows as missing. It may not work.`);
        p.log.warning("Run 'openclaw models auth login' to set up auth, or change the model.");
      }
    } catch {
      // models list failed — not critical
    }
  } catch {
    p.log.warning("Could not read OpenClaw config to verify model.");
  }

  // --- 3. Sandbox mode ---
  const mode = await p.select({
    message: "How should sharkcage sandbox OpenClaw?",
    options: [
      {
        value: "full" as Mode,
        label: "Full sandbox (recommended)",
        hint: "Outer ASRT sandbox + per-session + per-skill sandboxing",
      },
      {
        value: "skills-only" as Mode,
        label: "Skills only",
        hint: "No outer sandbox. Just sandbox skills you install.",
      },
    ],
  });

  if (p.isCancel(mode)) { p.cancel("Cancelled."); process.exit(0); }

  // --- 4. Write config ---
  mkdirSync(configDir, { recursive: true });
  const configPath = `${configDir}/gateway.json`;

  if (existsSync(configPath)) {
    const overwrite = await p.confirm({ message: "Sharkcage config already exists. Overwrite?" });
    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("Keeping existing config.");
      return;
    }
  }

  const config: SharkcageConfig = {
    mode,
    outerSandbox: mode === "full",
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Create directories
  for (const dir of [`${configDir}/data`, `${configDir}/plugins`, `${configDir}/approvals`, `${configDir}/denied`]) {
    mkdirSync(dir, { recursive: true });
  }

  // --- 5. Next steps ---
  p.note(
    `Start sharkcage:\n  sc start\n\n` +
    `Install skills:\n  sc skill add <url>\n\n` +
    `Dashboard will be available after start.`,
    "Next steps"
  );

  p.outro("Setup complete.");
}
