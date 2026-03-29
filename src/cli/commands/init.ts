/**
 * sharkcage init
 *
 * 1. Run openclaw onboard (if not already configured) — handles model, API keys, channels
 * 2. Choose sharkcage sandbox mode
 * 3. Write sharkcage config
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";

type Mode = "new" | "existing" | "skills-only";

interface SharkcageConfig {
  mode: Mode;
  outerSandbox: boolean;
  openclawManaged: boolean;
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
      // If there's a gateway config with mode set, assume onboard has been run
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

    // Run openclaw onboard interactively
    p.log.info("Starting OpenClaw setup wizard...\n");
    const result = spawnSync("openclaw", ["onboard", "--no-install-daemon"], {
      stdio: "inherit",
    });

    if (result.status !== 0) {
      p.log.error("OpenClaw setup failed. Fix the issue and re-run 'sc init'.");
      process.exit(1);
    }

    p.log.success("OpenClaw configured.\n");
  } else {
    p.log.success("OpenClaw already configured.");
  }

  // --- 2. Sandbox mode ---
  const mode = await p.select({
    message: "How should sharkcage sandbox OpenClaw?",
    options: [
      {
        value: "new" as Mode,
        label: "Full sandbox",
        hint: "Outer ASRT sandbox around OpenClaw + per-skill sandboxing. Recommended.",
      },
      {
        value: "existing" as Mode,
        label: "Wrap existing",
        hint: "Outer sandbox + skill lockdown. Existing skills need re-approval.",
      },
      {
        value: "skills-only" as Mode,
        label: "Skills only",
        hint: "No outer sandbox. Just sandbox new skills you install.",
      },
    ],
  });

  if (p.isCancel(mode)) { p.cancel("Cancelled."); process.exit(0); }

  // --- Warning for existing installs ---
  if (mode === "existing") {
    p.note(
      "Your existing skills have been running without a sandbox.\n" +
      "Sharkcage can't undo anything they've already done.\n" +
      "We recommend reviewing your installed skills before proceeding.",
      "Warning"
    );

    const proceed = await p.confirm({ message: "Continue?" });
    if (p.isCancel(proceed) || !proceed) { p.cancel("Cancelled."); process.exit(0); }
  }

  // --- 3. Write sharkcage config ---
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
    outerSandbox: mode !== "skills-only",
    openclawManaged: mode === "new",
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Create directories
  for (const dir of [`${configDir}/data`, `${configDir}/plugins`, `${configDir}/approvals`]) {
    mkdirSync(dir, { recursive: true });
  }

  // --- 4. Next steps ---
  p.note(
    `Start sharkcage:\n  sc start\n\n` +
    `Install skills:\n  sc plugin add <url>\n\n` +
    `Dashboard will be available after start.`,
    "Next steps"
  );

  p.outro("Setup complete.");
}
