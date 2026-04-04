/**
 * sc selfupdate
 *
 * Self-update sharkcage by fetching the latest git tag, checking out
 * that tag, reinstalling deps, rebuilding the plugin, and updating
 * the install manifest.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { loadManifest, writeManifest, getInstallDir, getConfigDir, getDataDir } from "../lib/paths.ts";


export default async function selfupdate() {
  p.intro("sc selfupdate — update sharkcage to the latest release");

  // --- 1. Read current state ---
  const manifest = loadManifest();
  if (!manifest) {
    p.log.error("Install manifest not found. Run `sc init` first.");
    process.exit(1);
  }

  const installDir = getInstallDir();
  const execOpts = { cwd: installDir, encoding: "utf-8" as const, timeout: 30_000 };

  let currentCommit: string;
  try {
    currentCommit = execFileSync("git", ["rev-parse", "HEAD"], execOpts).trim();
  } catch {
    p.log.error("Could not read current git commit. Is this a git clone?");
    process.exit(1);
  }

  const currentRef = manifest.gitRef ?? currentCommit.slice(0, 8);
  p.log.info(`Current ref: ${currentRef} (${currentCommit.slice(0, 8)})`);

  // --- 2. Fetch latest ---
  p.log.info("Fetching tags from origin...");
  try {
    execFileSync("git", ["fetch", "--quiet", "--tags", "origin"], execOpts);
  } catch {
    p.log.error("git fetch failed. Check your network and remote config.");
    process.exit(1);
  }

  // --- 3. Resolve latest tag ---
  let latestTag: string;
  try {
    const tags = execFileSync("git", ["tag", "-l", "v*", "--sort=-version:refname"], execOpts).trim();
    const first = tags.split("\n")[0];
    if (!first) throw new Error("no tags");
    latestTag = first;
  } catch {
    p.log.error("No release tags found. Cannot determine latest version.");
    process.exit(1);
  }

  // --- 4. Compare ---
  let tagCommit: string;
  try {
    tagCommit = execFileSync("git", ["rev-parse", `${latestTag}^{}`], execOpts).trim();
  } catch {
    p.log.error(`Could not resolve tag ${latestTag}.`);
    process.exit(1);
  }

  if (currentCommit === tagCommit) {
    p.log.success(`Already on latest (${latestTag}).`);
    p.outro("Nothing to do.");
    return;
  }

  // --- 5. Show plan and confirm ---
  p.note(
    `Update: ${currentRef} → ${latestTag}\n\n` +
    "This will:\n" +
    "  1. Back up your configs\n" +
    "  2. Check out the new tag\n" +
    "  3. Run npm ci\n" +
    "  4. Rebuild the plugin\n" +
    "  5. Update the install manifest",
    "Update plan"
  );

  const proceed = await p.confirm({ message: "Continue?" });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // --- 6. Backup configs ---
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(getDataDir(), "backups", timestamp);
  mkdirSync(backupPath, { recursive: true });

  const configFiles: Array<{ src: string; dest: string }> = [
    { src: join(installDir, ".openclaw", "openclaw.json"), dest: "openclaw.json" },
    { src: join(getConfigDir(), "gateway.json"), dest: "gateway.json" },
    { src: join(getConfigDir(), "gateway-sandbox.json"), dest: "gateway-sandbox.json" },
  ];

  for (const { src, dest } of configFiles) {
    if (existsSync(src)) {
      copyFileSync(src, join(backupPath, dest));
    }
  }
  p.log.success(`Backed up to ${backupPath}`);

  // --- 7. Checkout ---
  p.log.info(`Checking out ${latestTag}...`);
  try {
    execFileSync("git", ["checkout", "--quiet", latestTag], execOpts);
  } catch {
    p.log.error(`git checkout ${latestTag} failed.`);
    process.exit(1);
  }

  // --- 8. Install deps ---
  p.log.info("Installing dependencies...");
  const npmResult = spawnSync("npm", ["ci", "--silent"], {
    stdio: "inherit",
    cwd: installDir,
    timeout: 180_000,
  });

  if (npmResult.status !== 0) {
    // Retry without --silent for better error output
    p.log.warning("Retrying npm ci without --silent...");
    const retry = spawnSync("npm", ["ci"], {
      stdio: "inherit",
      cwd: installDir,
      timeout: 180_000,
    });
    if (retry.status !== 0) {
      p.log.error("npm ci failed. You may need to fix this manually.");
      process.exit(1);
    }
  }

  // --- 9. Rebuild plugin ---
  p.log.info("Building plugin...");
  const tscResult = spawnSync("npx", ["tsc", "-p", "tsconfig.plugin.json", "--outDir", "dist/sharkcage-build"], {
    stdio: "inherit",
    cwd: installDir,
    timeout: 60_000,
  });

  if (tscResult.status !== 0) {
    p.log.error("Plugin build failed.");
    process.exit(1);
  }

  // Copy built files
  const distDirs = ["dist/sharkcage", "dist/supervisor", "dist/shared"];
  for (const d of distDirs) {
    mkdirSync(join(installDir, d), { recursive: true });
  }

  const copyPairs: Array<{ from: string; to: string }> = [
    { from: "dist/sharkcage-build/plugin", to: "dist/sharkcage" },
    { from: "dist/sharkcage-build/shared", to: "dist/shared" },
  ];

  for (const { from, to } of copyPairs) {
    const srcDir = join(installDir, from);
    if (existsSync(srcDir)) {
      spawnSync("cp", ["-r", `${srcDir}/.`, join(installDir, to)], { stdio: "pipe" });
    }
  }

  // Copy supervisor types
  const supervisorTypesJs = join(installDir, "dist/sharkcage-build/supervisor/types.js");
  const supervisorTypesTs = join(installDir, "dist/sharkcage-build/supervisor/types.d.ts");
  if (existsSync(supervisorTypesJs)) {
    copyFileSync(supervisorTypesJs, join(installDir, "dist/supervisor/types.js"));
  }
  if (existsSync(supervisorTypesTs)) {
    copyFileSync(supervisorTypesTs, join(installDir, "dist/supervisor/types.d.ts"));
  }

  // Copy plugin metadata
  const pluginJson = join(installDir, "src/plugin/openclaw.plugin.json");
  const securityJson = join(installDir, "src/plugin/security-patterns.json");
  if (existsSync(pluginJson)) {
    copyFileSync(pluginJson, join(installDir, "dist/sharkcage/openclaw.plugin.json"));
  }
  if (existsSync(securityJson)) {
    copyFileSync(securityJson, join(installDir, "dist/sharkcage/security-patterns.json"));
  }

  p.log.success("Plugin rebuilt.");

  // --- 10. Update manifest ---
  const newCommit = execFileSync("git", ["rev-parse", "HEAD"], execOpts).trim();
  let newVersion = manifest.version;
  try {
    const pkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf-8")) as { version: string };
    newVersion = pkg.version;
  } catch { /* keep existing */ }

  writeManifest({
    ...manifest,
    version: newVersion,
    installedAt: new Date().toISOString(),
    gitRef: latestTag,
    gitCommit: newCommit,
  });

  p.log.success(`Updated: ${currentRef} → ${latestTag}`);

  // --- 11. Next steps ---
  const isLinux = process.platform === "linux";
  const restartCmd = isLinux
    ? "sudo systemctl restart sharkcage"
    : "sc stop && sc start";

  p.note(
    `Restart to apply the update:\n  ${restartCmd}\n\n` +
    `Backup available at: ${backupPath}`,
    "Next steps"
  );
  p.outro("Self-update complete.");
}
