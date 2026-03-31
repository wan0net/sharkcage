/**
 * sc init
 *
 * Post-install configuration wizard:
 * 1. Read install manifest (written by install.sh)
 * 2. Run openclaw onboard if needed
 * 3. Choose sandbox mode
 * 4. Dedicated user setup (Linux only)
 * 5. Systemd service install (Linux only)
 * 6. Write gateway.json
 * 7. Print summary
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import {
  requireManifest,
  writeManifest,
  getGatewayConfigPath,
  ensureDataDirs,
} from "../lib/paths.ts";

type Mode = "full" | "skills-only";

interface GatewayConfig {
  mode: Mode;
  runAsUser?: string;
}

const home = process.env.HOME ?? ".";

export default async function init() {
  p.intro("sharkcage init");

  // --- 1. Read install manifest ---
  const manifest = requireManifest(); // exits if missing
  p.log.info(`Install directory: ${manifest.installDir}`);

  // --- 2. OpenClaw onboard ---
  const ocConfigPath = `${home}/.openclaw/openclaw.json`;
  let needsOnboard = true;

  if (existsSync(ocConfigPath)) {
    try {
      const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
      if (ocConfig.gateway?.mode) {
        needsOnboard = false;
      }
    } catch {
      /* can't read */
    }
  }

  if (needsOnboard) {
    p.note(
      "OpenClaw needs to be set up first.\n" +
        "This wizard will configure your model, API key, channels, and gateway.\n" +
        "After that, sharkcage will configure sandboxing.",
      "OpenClaw Setup",
    );

    const runOnboard = await p.confirm({
      message: "Run OpenClaw setup wizard now?",
    });
    if (p.isCancel(runOnboard) || !runOnboard) {
      p.cancel(
        `Run '${manifest.openclawBin} onboard' manually, then re-run 'sc init'.`,
      );
      process.exit(0);
    }

    console.log("");
    console.log("┌──────────────────────────────────────────────┐");
    console.log("│  OpenClaw Setup (not sharkcage)              │");
    console.log("│  Everything below is OpenClaw's own wizard.  │");
    console.log("│  Sharkcage setup continues after.            │");
    console.log("└──────────────────────────────────────────────┘");
    console.log("");

    const result = spawnSync(
      manifest.openclawBin,
      ["onboard", "--no-install-daemon", "--skip-skills"],
      { stdio: "inherit" },
    );

    if (result.status !== 0) {
      p.log.error("OpenClaw setup failed. Fix the issue and re-run 'sc init'.");
      process.exit(1);
    }

    console.log("");
    console.log("┌──────────────────────────────────────────────┐");
    console.log("│  Back to Sharkcage                           │");
    console.log("└──────────────────────────────────────────────┘");
    console.log("");
  } else {
    p.log.success("OpenClaw already configured.");
  }

  // Parse model from openclaw config
  try {
    const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
    const model = ocConfig.agents?.defaults?.model;
    const modelStr =
      typeof model === "string" ? model : (model?.primary ?? "unknown");
    p.log.info(`Model: ${modelStr}`);
  } catch {
    p.log.warning("Could not read OpenClaw config to verify model.");
  }

  // --- 3. Sandbox mode ---
  // Load existing gateway config for defaults
  const gatewayPath = getGatewayConfigPath();
  let existingConfig: GatewayConfig | null = null;
  if (existsSync(gatewayPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(gatewayPath, "utf-8"));
    } catch {
      /* ignore */
    }
  }

  const mode = await p.select({
    message: "How should sharkcage sandbox OpenClaw?",
    initialValue: existingConfig?.mode ?? ("full" as Mode),
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

  if (p.isCancel(mode)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // --- 4. Dedicated user setup (Linux only) ---
  let runAsUser: string | undefined = existingConfig?.runAsUser;

  if (process.platform === "linux") {
    const useHardening = await p.confirm({
      message:
        "Create a dedicated user to run OpenClaw? (recommended for servers)",
      initialValue: !!runAsUser,
    });

    if (!p.isCancel(useHardening) && useHardening) {
      const username = await p.text({
        message: "Username for the dedicated user:",
        initialValue: runAsUser ?? "openclaw",
        validate: (v) => {
          if (!v || !/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) return "Invalid username";
        },
      });

      if (p.isCancel(username)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      // Check if user exists
      let userExists = false;
      try {
        execFileSync("id", [username], { stdio: "pipe" });
        userExists = true;
        p.log.success(`User "${username}" already exists.`);
      } catch {
        // Need to create
      }

      try {
        // Request sudo -- user enters password here
        execFileSync("sudo", ["-v"], { stdio: "inherit" });

        if (!userExists) {
          p.log.info(`Creating user "${username}" (requires sudo)...`);
          execFileSync(
            "sudo",
            [
              "useradd",
              "--system",
              "--create-home",
              "--home-dir",
              `/home/${username}`,
              "--shell",
              "/usr/sbin/nologin",
              username,
            ],
            { stdio: "inherit" },
          );
          p.log.success(`User "${username}" created.`);
        }

        // chown the install dir to the dedicated user (no copying)
        p.log.info(
          `Setting ownership of ${manifest.installDir} to ${username}...`,
        );
        execFileSync(
          "sudo",
          ["chown", "-R", `${username}:${username}`, manifest.installDir],
          { stdio: "pipe" },
        );
        p.log.success(`Install directory owned by ${username}.`);

        // Set up passwordless sudo for running openclaw as the dedicated user
        const sudoersRule = `${manifest.installedBy} ALL=(${username}) NOPASSWD: ${manifest.openclawBin}\n`;
        const sudoersFile = `/etc/sudoers.d/sharkcage-${username}`;
        execFileSync("sudo", ["tee", sudoersFile], {
          input: sudoersRule,
          stdio: ["pipe", "pipe", "pipe"],
        });
        execFileSync("sudo", ["chmod", "440", sudoersFile], {
          stdio: "pipe",
        });
        p.log.success(`Sudoers rule written to ${sudoersFile}.`);

        // Update manifest with serviceUser
        manifest.serviceUser = username;
        writeManifest(manifest);
      } catch (err) {
        p.log.error(
          `Failed to set up user: ${err instanceof Error ? err.message : err}`,
        );
        p.log.warning("Continuing without dedicated user.");
      } finally {
        // Drop sudo immediately
        try {
          execFileSync("sudo", ["-k"], { stdio: "pipe" });
        } catch {
          /* ok */
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

  // --- 5. Systemd service (Linux only) ---
  let serviceInstalled = false;
  let serviceEnabled = false;
  let serviceStarted = false;

  if (process.platform === "linux") {
    const installService = await p.confirm({
      message: "Install systemd service for sharkcage?",
      initialValue: false,
    });

    if (!p.isCancel(installService) && installService) {
      const templatePath = `${manifest.installDir}/sharkcage.service`;

      if (!existsSync(templatePath)) {
        p.log.error(`Service template not found at ${templatePath}`);
      } else {
        try {
          let serviceContent = readFileSync(templatePath, "utf-8");
          const serviceUser = runAsUser ?? manifest.installedBy;

          serviceContent = serviceContent.replace(
            /\{\{INSTALL_DIR\}\}/g,
            manifest.installDir,
          );
          serviceContent = serviceContent.replace(
            /\{\{SERVICE_USER\}\}/g,
            serviceUser,
          );

          // Request sudo if not already cached
          execFileSync("sudo", ["-v"], { stdio: "inherit" });

          // Write service file
          const serviceDest = "/etc/systemd/system/sharkcage.service";
          execFileSync("sudo", ["tee", serviceDest], {
            input: serviceContent,
            stdio: ["pipe", "pipe", "pipe"],
          });
          p.log.success(`Service file written to ${serviceDest}.`);
          serviceInstalled = true;

          // Reload systemd
          execFileSync("sudo", ["systemctl", "daemon-reload"], {
            stdio: "pipe",
          });

          // Enable?
          const enableIt = await p.confirm({
            message: "Enable sharkcage service (start on boot)?",
            initialValue: true,
          });
          if (!p.isCancel(enableIt) && enableIt) {
            execFileSync("sudo", ["systemctl", "enable", "sharkcage"], {
              stdio: "pipe",
            });
            serviceEnabled = true;
            p.log.success("Service enabled.");
          }

          // Start now?
          const startNow = await p.confirm({
            message: "Start sharkcage service now?",
            initialValue: false,
          });
          if (!p.isCancel(startNow) && startNow) {
            execFileSync("sudo", ["systemctl", "start", "sharkcage"], {
              stdio: "pipe",
            });
            serviceStarted = true;
            p.log.success("Service started.");
          }
        } catch (err) {
          p.log.error(
            `Failed to install service: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          try {
            execFileSync("sudo", ["-k"], { stdio: "pipe" });
          } catch {
            /* ok */
          }
        }
      }
    }
  }

  // --- 6. Write gateway.json ---
  ensureDataDirs();
  // Ensure the etc directory exists for gateway.json
  const gatewayDir = dirname(gatewayPath);
  mkdirSync(gatewayDir, { recursive: true });

  const config: GatewayConfig = {
    mode,
    ...(runAsUser && { runAsUser }),
  };

  writeFileSync(gatewayPath, JSON.stringify(config, null, 2) + "\n");
  p.log.success(`Config written to ${gatewayPath}`);

  // --- 7. Summary ---
  const summaryLines: string[] = [
    `Install directory:  ${manifest.installDir}`,
    `OpenClaw binary:    ${manifest.openclawBin}`,
    `srt binary:         ${manifest.srtBin}`,
    `sc binary:          ${manifest.scBin}`,
    `Sandbox mode:       ${mode}`,
  ];

  if (runAsUser) {
    summaryLines.push(`Service user:       ${runAsUser}`);
  }

  if (serviceInstalled) {
    const status = serviceStarted
      ? "installed, enabled, running"
      : serviceEnabled
        ? "installed, enabled"
        : "installed";
    summaryLines.push(`Systemd service:    ${status}`);
  }

  summaryLines.push("");
  summaryLines.push("Next steps:");
  if (!serviceStarted) {
    summaryLines.push("  sc start");
  }
  summaryLines.push("  sc skill add <url>");

  p.note(summaryLines.join("\n"), "Setup complete");

  p.outro("Done.");
}
