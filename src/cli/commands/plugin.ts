/**
 * sharkcage plugin <subcommand>
 *
 * Subcommands:
 *   add <url|path>   Install a skill from git URL or local path
 *   list             List installed skills
 *   remove <name>    Remove an installed skill
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const pluginDir = `${configDir}/plugins`;

export default async function plugin() {
  const sub = process.argv[3];

  switch (sub) {
    case "add":
      await pluginAdd();
      break;
    case "list":
      pluginList();
      break;
    case "remove":
      await pluginRemove();
      break;
    default:
      console.log(`Usage:
  sc plugin add <url|path>     Install a skill
  sc plugin list               List installed skills
  sc plugin remove <name>      Remove a skill`);
  }
}

async function pluginAdd(): Promise<void> {
  const source = process.argv[4];
  if (!source) {
    console.error("Usage: sc plugin add <git-url|local-path>");
    process.exit(1);
  }

  mkdirSync(pluginDir, { recursive: true });

  let skillDir: string;
  let skillName: string;

  if (source.startsWith("http") || source.startsWith("git@")) {
    // Git clone
    skillName = basename(source).replace(/\.git$/, "").replace(/^sharkcage-skill-/, "").replace(/^sharkcage-plugin-/, "");
    skillDir = join(pluginDir, skillName);

    if (existsSync(skillDir)) {
      console.error(`Skill "${skillName}" already installed at ${skillDir}`);
      console.error("Run 'sc plugin remove " + skillName + "' first.");
      process.exit(1);
    }

    console.log(`Cloning ${source}...`);
    try {
      execFileSync("git", ["clone", "--depth", "1", source, skillDir], { stdio: "inherit" });
    } catch {
      console.error("Git clone failed.");
      process.exit(1);
    }
  } else {
    // Local path — copy or symlink
    const absPath = source.startsWith("/") ? source : join(process.cwd(), source);
    if (!existsSync(absPath)) {
      console.error(`Path not found: ${absPath}`);
      process.exit(1);
    }

    // Read name from manifest
    const manifestPath = join(absPath, "plugin.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      skillName = manifest.name ?? basename(absPath);
    } else {
      skillName = basename(absPath);
    }

    skillDir = join(pluginDir, skillName);
    if (existsSync(skillDir)) {
      console.error(`Skill "${skillName}" already installed.`);
      process.exit(1);
    }

    // Symlink for local development
    console.log(`Linking ${absPath} -> ${skillDir}`);
    execFileSync("ln", ["-s", absPath, skillDir]);
  }

  // --- Scan ---
  console.log("\nScanning...\n");
  const manifestPath = join(skillDir, "plugin.json");

  if (!existsSync(manifestPath)) {
    console.warn("  No plugin.json found.");
    console.warn("  Run AI capability inference: sc infer " + skillName);
    console.log(`\n  Installed to ${skillDir} (no capabilities defined yet)\n`);
    return;
  }

  // Run verify
  try {
    const verify = await import("./verify.js");
    // verify reads from process.argv, so we need to set it up
    const origArgs = process.argv;
    process.argv = ["", "", skillDir];
    await verify.default();
    process.argv = origArgs;
  } catch {
    console.log("  (scanner skipped)");
  }

  // --- Prompt for approval ---
  console.log("");
  const answer = await ask("Approve capabilities now? [Y/n] ");
  if (answer.toLowerCase() !== "n") {
    const origArgs = process.argv;
    process.argv = ["", "", "", skillName];
    const approveMod = await import("./approve.js");
    await approveMod.default();
    process.argv = origArgs;
  }

  console.log(`\nInstalled: ${skillName} → ${skillDir}\n`);
}

function pluginList(): void {
  if (!existsSync(pluginDir)) {
    console.log("No skills installed.");
    return;
  }

  const entries = readdirSync(pluginDir);
  if (entries.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log("Installed skills:\n");

  for (const name of entries) {
    const fullPath = join(pluginDir, name);
    try {
      if (!statSync(fullPath).isDirectory() && !statSync(fullPath).isSymbolicLink()) continue;
    } catch { continue; }

    const manifestPath = join(fullPath, "plugin.json");
    let version = "?";
    let description = "";
    let capCount = 0;

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        version = manifest.version ?? "?";
        description = manifest.description ?? "";
        capCount = manifest.capabilities?.length ?? 0;
      } catch { /* can't parse */ }
    }

    // Check approval status
    const approvalPath = `${configDir}/approvals/${name}.json`;
    const approved = existsSync(approvalPath);

    const status = approved ? "[approved]" : "[pending]";
    console.log(`  ${name} v${version} ${status}`);
    if (description) console.log(`    ${description}`);
    console.log(`    ${capCount} capabilities, ${approved ? "approved" : "needs approval"}`);
    console.log("");
  }
}

async function pluginRemove(): Promise<void> {
  const name = process.argv[4];
  if (!name) {
    console.error("Usage: sc plugin remove <skill-name>");
    process.exit(1);
  }

  const skillDir = join(pluginDir, name);
  if (!existsSync(skillDir)) {
    console.error(`Skill not found: ${name}`);
    process.exit(1);
  }

  const answer = await ask(`Remove skill "${name}"? This deletes the skill and its approval. [y/N] `);
  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  rmSync(skillDir, { recursive: true, force: true });
  console.log(`  Removed: ${skillDir}`);

  const approvalPath = `${configDir}/approvals/${name}.json`;
  if (existsSync(approvalPath)) {
    rmSync(approvalPath);
    console.log(`  Removed approval: ${approvalPath}`);
  }

  console.log("Done.");
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
