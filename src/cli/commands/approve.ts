/**
 * sharkcage approve <skill-name>
 *
 * Review and approve capabilities for an installed skill.
 * Reads plugin.json, shows capabilities with risk levels,
 * prompts for approval, writes to ~/.config/sharkcage/approvals/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { getApprovalsDir, getPluginDir } from "../lib/paths.ts";

const pluginDir = getPluginDir();
const approvalsDir = getApprovalsDir();

interface Capability {
  capability: string;
  reason: string;
  scope?: string[];
}

interface PluginManifest {
  name: string;
  version: string;
  capabilities?: Capability[];
}

const RISK: Record<string, { level: string; icon: string }> = {
  "network.external": { level: "medium", icon: "~" },
  "network.internal": { level: "medium", icon: "~" },
  "home.read": { level: "low", icon: "." },
  "home.control": { level: "medium", icon: "~" },
  "home.automation": { level: "medium", icon: "~" },
  "data.meals": { level: "low", icon: "." },
  "data.history": { level: "medium", icon: "~" },
  "data.memory": { level: "medium", icon: "~" },
  "data.preferences": { level: "low", icon: "." },
  "fleet.dispatch": { level: "medium", icon: "~" },
  "fleet.read": { level: "low", icon: "." },
  "fleet.manage": { level: "high", icon: "!" },
  "notify.signal": { level: "high", icon: "!" },
  "notify.push": { level: "low", icon: "." },
  "system.files.read": { level: "high", icon: "!" },
  "system.files.write": { level: "dangerous", icon: "X" },
  "system.exec": { level: "dangerous", icon: "X" },
  "system.env": { level: "high", icon: "!" },
  "cost.api": { level: "medium", icon: "~" },
};

export default async function approve() {
  const skillName = process.argv[3];
  if (!skillName) {
    console.error("Usage: sc approve <skill-name>");
    process.exit(1);
  }

  // Find plugin manifest
  const manifestPath = `${pluginDir}/${skillName}/plugin.json`;
  if (!existsSync(manifestPath)) {
    console.error(`Skill not found: ${skillName}`);
    console.error(`Expected: ${manifestPath}`);
    process.exit(1);
  }

  const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const capabilities = manifest.capabilities ?? [];

  if (capabilities.length === 0) {
    console.log(`Skill "${skillName}" declares no capabilities.`);
    console.log("It will run with no network, filesystem, or service access.");
    return;
  }

  // Check existing approval
  const approvalPath = `${approvalsDir}/${skillName}.json`;
  if (existsSync(approvalPath)) {
    const existing = JSON.parse(readFileSync(approvalPath, "utf-8"));
    if (existing.version === manifest.version) {
      console.log(`Skill "${skillName}" v${manifest.version} is already approved.`);
      console.log(`  Approved: ${existing.capabilities.map((c: Capability) => c.capability).join(", ")}`);

      const answer = await ask("Re-approve? [y/N] ");
      if (answer.toLowerCase() !== "y") return;
    } else {
      console.log(`Skill "${skillName}" updated: v${existing.version} -> v${manifest.version}\n`);
    }
  }

  // Display capabilities
  console.log(`\nSkill: ${manifest.name} v${manifest.version}\n`);
  console.log("Requested capabilities:\n");

  let hasDangerous = false;

  for (const cap of capabilities) {
    const risk = RISK[cap.capability] ?? { level: "unknown", icon: "?" };
    const scope = cap.scope?.length ? cap.scope.join(", ") : "unrestricted";
    const label = `[${risk.icon}] ${cap.capability} (${risk.level})`;

    console.log(`  ${label}`);
    console.log(`     ${cap.reason}`);
    if (cap.scope?.length) {
      console.log(`     Scope: ${scope}`);
    } else if (risk.level === "high" || risk.level === "dangerous") {
      console.log(`     Scope: UNRESTRICTED — no limits on this capability`);
      hasDangerous = true;
    }
    console.log("");
  }

  if (hasDangerous) {
    console.log("  WARNING: This skill requests dangerous capabilities without scope.");
    console.log("  It could access more than it needs. Consider asking the author to add scoping.\n");
  }

  // Prompt
  const answer = await ask("Approve all capabilities? [Y/n/edit] ");

  if (answer.toLowerCase() === "n") {
    console.log("Denied. Skill will not be able to run.");
    return;
  }

  if (answer.toLowerCase() === "edit") {
    console.log("\nApprove each capability individually:\n");
    const approved: Capability[] = [];
    const denied: string[] = [];

    for (const cap of capabilities) {
      const risk = RISK[cap.capability] ?? { level: "unknown", icon: "?" };
      const a = await ask(`  ${cap.capability} (${risk.level})? [Y/n] `);
      if (a.toLowerCase() === "n") {
        denied.push(cap.capability);
      } else {
        approved.push(cap);
      }
    }

    if (denied.length > 0) {
      console.log(`\nDenied: ${denied.join(", ")}`);
    }

    writeApproval(skillName, manifest.version, approved);
    console.log(`\nApproved ${approved.length}/${capabilities.length} capabilities.`);
    return;
  }

  // Approve all
  writeApproval(skillName, manifest.version, capabilities);
  console.log("Approved.");
}

function writeApproval(skill: string, version: string, capabilities: Capability[]): void {
  mkdirSync(approvalsDir, { recursive: true });
  const approval = {
    skill,
    version,
    capabilities,
    approvedAt: new Date().toISOString(),
  };
  writeFileSync(`${approvalsDir}/${skill}.json`, JSON.stringify(approval, null, 2) + "\n");
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
