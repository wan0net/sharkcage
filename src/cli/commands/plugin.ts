/**
 * sharkcage plugin <subcommand>
 *
 * Subcommands:
 *   add <url|path>   Install a skill from git URL or local path
 *   list             List installed skills
 *   remove <name>    Remove an installed skill
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.HOME ?? ".";
const configDir = process.env.SHARKCAGE_CONFIG_DIR ?? `${home}/.config/sharkcage`;
const pluginDir = `${configDir}/plugins`;
const dataDir = process.env.SHARKCAGE_DATA_DIR ?? `${home}/.local/share/sharkcage`;

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
    case "infer":
      await pluginInfer();
      break;
    default:
      console.log(`Usage:
  sc plugin add <url|path>     Install a skill
  sc plugin list               List installed skills
  sc plugin remove <name>      Remove a skill
  sc plugin infer <name>       Infer manifest for an installed skill`);
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

  // --- Manifest (infer if missing) ---
  console.log("\nScanning...\n");
  const manifestPath = join(skillDir, "plugin.json");

  if (!existsSync(manifestPath)) {
    console.warn("  No plugin.json found — running static analysis...");
    const { inferManifest } = await import("../../supervisor/manifest-inference.js");
    const result = inferManifest(skillDir);
    const full = { ...result.manifest, type: "plugin" as const };
    writeFileSync(manifestPath, JSON.stringify(full, null, 2) + "\n");
    console.log(`  ⚠️  No manifest found — generated from static analysis (confidence: ${result.confidence})`);
    for (const note of result.notes) {
      console.log(`     · ${note}`);
    }
    console.log("");
  }

  // --- Read manifest ---
  let manifest: { name?: string; version?: string; capabilities?: Array<{ capability: string; reason: string; scope?: string[] }> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    console.warn("  Could not parse plugin.json — skipping capability review.");
    console.log(`\nInstalled: ${skillName} → ${skillDir}\n`);
    return;
  }

  // --- Capabilities summary ---
  const caps = manifest.capabilities ?? [];
  console.log(`  Skill: ${manifest.name ?? skillName} v${manifest.version ?? "?"}`);
  if (caps.length > 0) {
    console.log("  Capabilities:");
    for (const cap of caps) {
      const scopePart = cap.scope?.length ? ` [${cap.scope.join(", ")}]` : "";
      console.log(`    · ${cap.capability}${scopePart} — ${cap.reason}`);
    }
  } else {
    console.log("  Capabilities: (none declared)");
  }
  console.log("");

  // --- Run verify ---
  try {
    const verify = await import("./verify.js");
    const origArgs = process.argv;
    process.argv = ["", "", skillDir];
    await verify.default();
    process.argv = origArgs;
  } catch {
    console.log("  (scanner skipped)");
  }

  // --- Approval ---
  console.log("");
  const supervisorSock = `${dataDir}/supervisor.sock`;
  if (existsSync(supervisorSock)) {
    // Supervisor is running — capabilities will be approved at first tool-call time
    // via the channel breakout flow. Still offer interactive approval if possible.
    if (process.stdin.isTTY) {
      const answer = await ask("Approve capabilities now? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        const origArgs = process.argv;
        process.argv = ["", "", "", skillName];
        const approveMod = await import("./approve.js");
        await approveMod.default();
        process.argv = origArgs;
      }
    } else {
      console.log("  Capabilities will be approved on first use via chat channel.");
    }
  } else {
    // No supervisor — interactive only
    if (process.stdin.isTTY) {
      const answer = await ask("Approve capabilities now? [Y/n] ");
      if (answer.toLowerCase() !== "n") {
        const origArgs = process.argv;
        process.argv = ["", "", "", skillName];
        const approveMod = await import("./approve.js");
        await approveMod.default();
        process.argv = origArgs;
      }
    } else {
      console.log("  Capabilities will be approved on first use via chat channel.");
    }
  }

  console.log(`\nInstalled: ${skillName}\n`);
}

async function pluginInfer(): Promise<void> {
  const skillName = process.argv[4];
  if (!skillName) {
    console.error("Usage: sc plugin infer <skill-name>");
    process.exit(1);
  }

  const skillDir = join(pluginDir, skillName);
  if (!existsSync(skillDir)) {
    console.error(`Skill not found: ${skillName}`);
    console.error(`Expected: ${skillDir}`);
    process.exit(1);
  }

  console.log(`\nRunning static analysis on ${skillName}...\n`);

  const { inferManifest } = await import("../../supervisor/manifest-inference.js");
  const result = inferManifest(skillDir);

  console.log(`Confidence: ${result.confidence}`);
  console.log("\nNotes:");
  for (const note of result.notes) {
    console.log(`  · ${note}`);
  }

  console.log("\nInferred capabilities:");
  const caps = result.manifest.capabilities ?? [];
  if (caps.length === 0) {
    console.log("  (none detected)");
  } else {
    for (const cap of caps) {
      const scopePart = cap.scope?.length ? ` [${cap.scope.join(", ")}]` : "";
      console.log(`  · ${cap.capability}${scopePart} — ${cap.reason}`);
    }
  }

  console.log(`\nGenerated manifest:\n${JSON.stringify({ ...result.manifest, type: "plugin" }, null, 2)}\n`);

  const manifestPath = join(skillDir, "plugin.json");
  const existing = existsSync(manifestPath);
  const prompt = existing
    ? "plugin.json already exists. Overwrite with inferred manifest? [y/N] "
    : "Save inferred manifest as plugin.json? [Y/n] ";

  if (process.stdin.isTTY) {
    const answer = await ask(prompt);
    const save = existing ? answer.toLowerCase() === "y" : answer.toLowerCase() !== "n";
    if (save) {
      writeFileSync(manifestPath, JSON.stringify({ ...result.manifest, type: "plugin" }, null, 2) + "\n");
      console.log(`Saved: ${manifestPath}`);
    } else {
      console.log("Not saved.");
    }
  } else {
    console.log("(non-interactive — manifest not saved automatically)");
  }
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
