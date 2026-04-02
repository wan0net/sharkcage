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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import crypto from "node:crypto";
import * as p from "@clack/prompts";
import {
  ensureDataDirs,
  getGatewayConfigPath,
  requireManifest,
  writeManifest,
  type InstallManifest,
} from "../lib/paths.ts";

type Mode = "full" | "skills-only";

interface GatewayConfig {
  mode: Mode;
  runAsUser?: string;
}

export interface InitOptions {
  nonInteractive?: boolean;
  mode?: string;
  serviceUser?: string | boolean;
  installService?: boolean;
  enableService?: boolean;
  startService?: boolean;
}

export default async function init(options: InitOptions = {}) {
  p.intro("sharkcage init");

  const manifest = requireManifest();
  p.log.info(`Install directory: ${manifest.installDir}`);

  const ocConfigPath = `${manifest.installDir}/.openclaw/openclaw.json`;
  const needsOnboard = openClawNeedsOnboard(manifest, ocConfigPath);

  if (needsOnboard) {
    await runOpenClawOnboard(manifest, options);
  } else {
    p.log.success("OpenClaw already configured.");
  }

  logConfiguredModel(manifest, ocConfigPath);

  const gatewayPath = getGatewayConfigPath();
  const existingConfig = loadGatewayConfig(gatewayPath);
  const mode = await resolveMode(existingConfig, options);
  const runAsUser = await resolveServiceUser(existingConfig, manifest, options);
  const {
    serviceInstalled,
    serviceEnabled,
    serviceStarted,
  } = await configureSystemdService(manifest, runAsUser, options);

  ensureDataDirsForUser(manifest, runAsUser);
  mkdirSync(dirname(gatewayPath), { recursive: true });
  const config: GatewayConfig = { mode, ...(runAsUser && { runAsUser }) };
  writeGatewayConfigForUser(gatewayPath, config, runAsUser);
  p.log.success(`Config written to ${gatewayPath}`);

  if (runAsUser) {
    try {
      execFileSync("sudo", ["-v"], { stdio: options.nonInteractive ? "pipe" : "inherit" });
      p.log.info(`Setting ownership of ${manifest.installDir} to ${runAsUser}...`);
      execFileSync("sudo", ["chown", "-R", `${runAsUser}:${runAsUser}`, manifest.installDir], {
        stdio: "pipe",
      });
      p.log.success(`Install directory owned by ${runAsUser}.`);
    } catch (err) {
      p.log.error(`Failed to chown: ${err instanceof Error ? err.message : err}`);
    } finally {
      try {
        execFileSync("sudo", ["-k"], { stdio: "pipe" });
      } catch {
        /* ok */
      }
    }
  }

  const summaryLines: string[] = [
    `Install directory:  ${manifest.installDir}`,
    `OpenClaw binary:    ${manifest.openclawBin}`,
    `srt binary:         ${manifest.srtBin}`,
    `sc binary:          ${manifest.scBin}`,
    `Sandbox mode:       ${mode}`,
  ];

  if (runAsUser) summaryLines.push(`Service user:       ${runAsUser}`);
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
  if (!serviceStarted) summaryLines.push("  sc start");
  summaryLines.push("  sc skill add <url>");

  p.note(summaryLines.join("\n"), "Setup complete");
  p.outro("Done.");
}

function openClawNeedsOnboard(manifest: InstallManifest, ocConfigPath: string): boolean {
  if (!canAccessOpenClawConfig(manifest, ocConfigPath)) return true;
  try {
    const ocConfig = JSON.parse(readOpenClawConfig(manifest, ocConfigPath));
    return !ocConfig.gateway?.mode;
  } catch {
    return true;
  }
}

async function runOpenClawOnboard(manifest: InstallManifest, options: InitOptions) {
  if (options.nonInteractive) {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      p.log.error(
        "OpenClaw config is missing and non-interactive init requires OPENROUTER_API_KEY in the environment.",
      );
      process.exit(1);
    }

    p.log.info("OpenClaw config missing — running non-interactive OpenClaw onboard.");
    const token = crypto.randomBytes(24).toString("hex");
    const result = runOpenClawCommand(manifest, [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--auth-choice",
      "openrouter-api-key",
      "--openrouter-api-key",
      openRouterApiKey,
      "--gateway-bind",
      "loopback",
      "--gateway-auth",
      "token",
      "--gateway-token",
      token,
      "--flow",
      "quickstart",
      "--skip-channels",
      "--skip-search",
      "--skip-ui",
      "--skip-health",
      "--no-install-daemon",
      "--skip-skills",
    ]);

    if (result.status !== 0) {
      p.log.error("OpenClaw setup failed. Fix the issue and re-run 'sc init'.");
      process.exit(1);
    }
    return;
  }

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
    p.cancel(`Run '${manifest.openclawBin} onboard' manually, then re-run 'sc init'.`);
    process.exit(0);
  }

  console.log("");
  console.log("┌──────────────────────────────────────────────┐");
  console.log("│  OpenClaw Setup (not sharkcage)              │");
  console.log("│  Everything below is OpenClaw's own wizard.  │");
  console.log("│  Sharkcage setup continues after.            │");
  console.log("└──────────────────────────────────────────────┘");
  console.log("");

  const result = runOpenClawCommand(manifest, ["onboard", "--no-install-daemon", "--skip-skills"]);

  if (result.status !== 0) {
    p.log.error("OpenClaw setup failed. Fix the issue and re-run 'sc init'.");
    process.exit(1);
  }

  console.log("");
  console.log("┌──────────────────────────────────────────────┐");
  console.log("│  Back to Sharkcage                           │");
  console.log("└──────────────────────────────────────────────┘");
  console.log("");
}

function logConfiguredModel(manifest: InstallManifest, ocConfigPath: string) {
  try {
    const ocConfig = JSON.parse(readOpenClawConfig(manifest, ocConfigPath));
    const model = ocConfig.agents?.defaults?.model;
    const modelStr = typeof model === "string" ? model : (model?.primary ?? "unknown");
    p.log.info(`Model: ${modelStr}`);
  } catch {
    p.log.warning("Could not read OpenClaw config to verify model.");
  }
}

function canAccessOpenClawConfig(manifest: InstallManifest, ocConfigPath: string): boolean {
  if (existsSync(ocConfigPath)) return true;
  const serviceUser = manifest.serviceUser;
  if (!serviceUser || process.platform !== "linux") return false;
  try {
    execFileSync("sudo", ["-u", serviceUser, "test", "-f", ocConfigPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function readOpenClawConfig(manifest: InstallManifest, ocConfigPath: string): string {
  try {
    return readFileSync(ocConfigPath, "utf-8");
  } catch {
    const serviceUser = manifest.serviceUser;
    if (!serviceUser || process.platform !== "linux") throw new Error("OpenClaw config unavailable");
    return execFileSync("sudo", ["-u", serviceUser, "cat", ocConfigPath], {
      encoding: "utf-8",
      stdio: "pipe",
    });
  }
}

function runOpenClawCommand(manifest: InstallManifest, args: string[]) {
  const serviceUser = manifest.serviceUser;
  const needsSudo = !!serviceUser && process.platform === "linux" && process.env.USER !== serviceUser;
  const command = needsSudo ? "sudo" : manifest.openclawBin;
  const commandArgs = needsSudo
    ? ["-u", serviceUser!, "env", `HOME=${manifest.installDir}`, manifest.openclawBin, ...args]
    : args;

  return spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, HOME: manifest.installDir },
  });
}

function ensureDataDirsForUser(manifest: InstallManifest, runAsUser?: string): void {
  if (!runAsUser || process.platform !== "linux" || process.env.USER === runAsUser) {
    ensureDataDirs();
    return;
  }

  const baseDir = `${manifest.installDir}/var`;
  for (const sub of ["plugins", "approvals", "denied", "backups"]) {
    execFileSync("sudo", ["-u", runAsUser, "mkdir", "-p", `${baseDir}/${sub}`], {
      stdio: "pipe",
    });
  }
}

function writeGatewayConfigForUser(
  gatewayPath: string,
  config: GatewayConfig,
  runAsUser?: string,
): void {
  const content = JSON.stringify(config, null, 2) + "\n";
  if (!runAsUser || process.platform !== "linux" || process.env.USER === runAsUser) {
    writeFileSync(gatewayPath, content);
    return;
  }

  execFileSync("sudo", ["-u", runAsUser, "tee", gatewayPath], {
    input: content,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function loadGatewayConfig(gatewayPath: string): GatewayConfig | null {
  if (!existsSync(gatewayPath)) return null;
  try {
    return JSON.parse(readFileSync(gatewayPath, "utf-8")) as GatewayConfig;
  } catch {
    return null;
  }
}

async function resolveMode(existingConfig: GatewayConfig | null, options: InitOptions): Promise<Mode> {
  if (options.mode != null) {
    if (options.mode !== "full" && options.mode !== "skills-only") {
      p.log.error(`Invalid mode '${options.mode}'. Use 'full' or 'skills-only'.`);
      process.exit(1);
    }
    return options.mode;
  }

  if (options.nonInteractive) return existingConfig?.mode ?? "full";

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

  return mode;
}

async function resolveServiceUser(
  existingConfig: GatewayConfig | null,
  manifest: InstallManifest,
  options: InitOptions,
): Promise<string | undefined> {
  let runAsUser: string | undefined = existingConfig?.runAsUser;

  if (process.platform !== "linux") return runAsUser;
  if (options.serviceUser === false) return undefined;

  let desiredUser: string | undefined;

  if (typeof options.serviceUser === "string") {
    desiredUser = options.serviceUser;
  } else if (!options.nonInteractive) {
    const useHardening = await p.confirm({
      message: "Create a dedicated user to run OpenClaw? (recommended for servers)",
      initialValue: !!runAsUser,
    });

    if (!p.isCancel(useHardening) && useHardening) {
      const username = await p.text({
        message: "Username for the dedicated user:",
        initialValue: runAsUser ?? "openclaw",
        validate: validateUsername,
      });

      if (p.isCancel(username)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      desiredUser = username;
    }
  }

  if (!desiredUser) return runAsUser;
  if (validateUsername(desiredUser)) {
    p.log.error(validateUsername(desiredUser)!);
    process.exit(1);
  }

  return ensureServiceUser(manifest, desiredUser, options.nonInteractive);
}

function validateUsername(value: string | undefined): string | undefined {
  if (!value || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) return "Invalid username";
  return undefined;
}

function ensureServiceUser(
  manifest: InstallManifest,
  username: string,
  nonInteractive?: boolean,
): string | undefined {
  let userExists = false;
  try {
    execFileSync("id", [username], { stdio: "pipe" });
    userExists = true;
    p.log.success(`User "${username}" already exists.`);
  } catch {
    /* will create */
  }

  if (userExists && manifest.serviceUser === username) {
    return username;
  }

  try {
    execFileSync("sudo", ["-v"], { stdio: nonInteractive ? "pipe" : "inherit" });

    if (!userExists) {
      p.log.info(`Creating user "${username}" (requires sudo)...`);
      execFileSync(
        "sudo",
        [
          "useradd",
          "--system",
          "--no-create-home",
          "--home-dir",
          manifest.installDir,
          "--shell",
          "/usr/sbin/nologin",
          username,
        ],
        { stdio: nonInteractive ? "pipe" : "inherit" },
      );
      p.log.success(`User "${username}" created.`);
    }

    manifest.serviceUser = username;
    writeManifest(manifest);

    const sudoersRule = `${manifest.installedBy} ALL=(${username}) NOPASSWD: ${manifest.scBin}, ${manifest.openclawBin}\n`;
    const sudoersFile = `/etc/sudoers.d/sharkcage-${username}`;
    execFileSync("sudo", ["tee", sudoersFile], {
      input: sudoersRule,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("sudo", ["chmod", "440", sudoersFile], { stdio: "pipe" });
    p.log.success(`Sudoers rule written to ${sudoersFile}.`);
  } catch (err) {
    p.log.error(`Failed to set up user: ${err instanceof Error ? err.message : err}`);
    p.log.warning("Continuing without dedicated user.");
  } finally {
    try {
      execFileSync("sudo", ["-k"], { stdio: "pipe" });
    } catch {
      /* ok */
    }
  }

  try {
    execFileSync("id", [username], { stdio: "pipe" });
    return username;
  } catch {
    return undefined;
  }
}

async function configureSystemdService(
  manifest: InstallManifest,
  runAsUser: string | undefined,
  options: InitOptions,
): Promise<{ serviceInstalled: boolean; serviceEnabled: boolean; serviceStarted: boolean }> {
  let serviceInstalled = false;
  let serviceEnabled = false;
  let serviceStarted = false;

  if (process.platform !== "linux") {
    return { serviceInstalled, serviceEnabled, serviceStarted };
  }

  let installService = options.installService || options.enableService || options.startService;
  if (!installService && !options.nonInteractive) {
    const answer = await p.confirm({
      message: "Install systemd service for sharkcage?",
      initialValue: false,
    });
    installService = !p.isCancel(answer) && answer;
  }

  if (!installService) {
    return { serviceInstalled, serviceEnabled, serviceStarted };
  }

  const templatePath = `${manifest.installDir}/sharkcage.service`;
  if (!existsSync(templatePath)) {
    p.log.error(`Service template not found at ${templatePath}`);
    return { serviceInstalled, serviceEnabled, serviceStarted };
  }

  try {
    let serviceContent = readFileSync(templatePath, "utf-8");
    const serviceUser = runAsUser ?? manifest.installedBy;

    serviceContent = serviceContent.replace(/\{\{INSTALL_DIR\}\}/g, manifest.installDir);
    serviceContent = serviceContent.replace(/\{\{SERVICE_USER\}\}/g, serviceUser);

    execFileSync("sudo", ["-v"], { stdio: options.nonInteractive ? "pipe" : "inherit" });

    const serviceDest = "/etc/systemd/system/sharkcage.service";
    execFileSync("sudo", ["tee", serviceDest], {
      input: serviceContent,
      stdio: ["pipe", "pipe", "pipe"],
    });
    p.log.success(`Service file written to ${serviceDest}.`);
    serviceInstalled = true;

    execFileSync("sudo", ["systemctl", "daemon-reload"], { stdio: "pipe" });

    let enableIt = !!options.enableService;
    if (!options.nonInteractive && !enableIt) {
      const answer = await p.confirm({
        message: "Enable sharkcage service (start on boot)?",
        initialValue: true,
      });
      enableIt = !p.isCancel(answer) && answer;
    }
    if (enableIt) {
      execFileSync("sudo", ["systemctl", "enable", "sharkcage"], { stdio: "pipe" });
      serviceEnabled = true;
      p.log.success("Service enabled.");
    }

    let startNow = !!options.startService;
    if (!options.nonInteractive && !startNow) {
      const answer = await p.confirm({
        message: "Start sharkcage service now?",
        initialValue: false,
      });
      startNow = !p.isCancel(answer) && answer;
    }
    if (startNow) {
      execFileSync("sudo", ["systemctl", "start", "sharkcage"], { stdio: "pipe" });
      serviceStarted = true;
      p.log.success("Service started.");
    }
  } catch (err) {
    p.log.error(`Failed to install service: ${err instanceof Error ? err.message : err}`);
  } finally {
    try {
      execFileSync("sudo", ["-k"], { stdio: "pipe" });
    } catch {
      /* ok */
    }
  }

  return { serviceInstalled, serviceEnabled, serviceStarted };
}
