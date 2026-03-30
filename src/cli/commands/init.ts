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
  runAsUser?: string;
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
      "After that, sharkcage will configure sandboxing.",
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
        hint: "Per-tool + per-skill kernel sandboxing via srt",
      },
      {
        value: "skills-only" as Mode,
        label: "Skills only",
        hint: "Only sandbox skill execution, not regular tool calls",
      },
    ],
  });

  if (p.isCancel(mode)) { p.cancel("Cancelled."); process.exit(0); }

  // --- 3b. Optional: dedicated user for hardened deployments ---
  let runAsUser: string | undefined;

  if (process.platform === "linux") {
    const useHardening = await p.confirm({
      message: "Create a dedicated user to run OpenClaw? (recommended for servers)",
      initialValue: false,
    });

    if (!p.isCancel(useHardening) && useHardening) {
      const username = await p.text({
        message: "Username for the dedicated user:",
        initialValue: "openclaw",
        validate: (v) => {
          if (!v || !/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) return "Invalid username";
        },
      });

      if (p.isCancel(username)) { p.cancel("Cancelled."); process.exit(0); }

      // Check if user exists
      let userExists = false;
      try {
        execFileSync("id", [username], { stdio: "pipe" });
        userExists = true;
        p.log.success(`User "${username}" already exists.`);
      } catch {
        // Need to create
      }

      if (!userExists) {
        p.log.info(`Creating user "${username}"...`);
        try {
          execFileSync("sudo", [
            "useradd",
            "--system",
            "--create-home",
            "--home-dir", `/home/${username}`,
            "--shell", "/usr/sbin/nologin",
            "--comment", "OpenClaw sandbox user",
            username,
          ], { stdio: "inherit" });

          // Set up the new user's home with sharkcage
          execFileSync("sudo", ["mkdir", "-p", `/home/${username}/.sharkcage`], { stdio: "pipe" });
          execFileSync("sudo", ["cp", "-r", `${home}/.sharkcage/.`, `/home/${username}/.sharkcage/`], { stdio: "pipe" });
          execFileSync("sudo", ["chown", "-R", `${username}:${username}`, `/home/${username}`], { stdio: "pipe" });

          p.log.success(`User "${username}" created. OpenClaw will run as this user.`);
        } catch (err) {
          p.log.error(`Failed to create user: ${err instanceof Error ? err.message : err}`);
          p.log.warning("Continuing without dedicated user.");
        }
      }

      // Verify the user exists before committing to config
      try {
        execFileSync("id", [username], { stdio: "pipe" });
        runAsUser = username;
      } catch {
        // User creation failed, don't set runAsUser
      }
    }
  }

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
    ...(runAsUser && { runAsUser }),
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
