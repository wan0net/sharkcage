/**
 * Maps tool names to the skill that owns them.
 *
 * Built at startup by scanning installed skill manifests.
 * Used by the interceptor to know which skill's approval
 * to check when a tool is called.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface SkillManifest {
  name: string;
  tools?: string[];
}

export class SkillMap {
  private toolToSkill = new Map<string, string>();

  /**
   * Scan plugin directory and build tool->skill mapping.
   */
  load(pluginDir: string): void {
    this.toolToSkill.clear();

    let entries: string[];
    try {
      entries = readdirSync(pluginDir);
    } catch {
      console.log(`[sharkcage-plugin] no plugin directory at ${pluginDir}`);
      return;
    }

    for (const name of entries) {
      const fullPath = join(pluginDir, name);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch { continue; }

      const manifestPath = join(fullPath, "plugin.json");
      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as SkillManifest;
        if (manifest.tools) {
          for (const tool of manifest.tools) {
            this.toolToSkill.set(tool, manifest.name);
          }
        } else {
          this.toolToSkill.set(`${manifest.name}_*`, manifest.name);
        }
      } catch {
        // No manifest or invalid — skip
      }
    }

    console.log(`[sharkcage-plugin] mapped ${this.toolToSkill.size} tool->skill entries`);
  }

  /**
   * Return all concrete tool→skill mappings (excludes wildcard entries).
   * Used by the plugin to register shadow tools for each skill tool.
   */
  getAllMappings(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [pattern, skill] of this.toolToSkill) {
      if (!pattern.endsWith("_*")) {
        result.set(pattern, skill);
      }
    }
    return result;
  }

  /**
   * Find which skill owns a tool.
   */
  getSkill(toolName: string): string | null {
    const direct = this.toolToSkill.get(toolName);
    if (direct) return direct;

    for (const [pattern, skill] of this.toolToSkill) {
      if (pattern.endsWith("_*")) {
        const prefix = pattern.slice(0, -2);
        if (toolName.startsWith(prefix + "_")) return skill;
      }
    }

    return null;
  }
}
