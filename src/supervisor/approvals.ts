import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillApproval } from "./types.js";

/**
 * Loads approval files from ~/.config/sharkcage/approvals/
 * Each file is {skill-name}.json containing the approved capabilities.
 */
export class ApprovalStore {
  private dir: string;
  private cache = new Map<string, SkillApproval>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Load all approvals from disk */
  loadAll(): void {
    this.cache.clear();
    try {
      const entries = readdirSync(this.dir);
      for (const name of entries) {
        const fullPath = join(this.dir, name);
        const stat = statSync(fullPath);
        if (!stat.isFile() || !name.endsWith(".json")) continue;
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const approval = JSON.parse(raw) as SkillApproval;
          if (approval.skill) {
            this.cache.set(approval.skill, approval);
          }
        } catch {
          console.error(`[approvals] failed to load ${name}`);
        }
      }
    } catch {
      console.log(`[approvals] no approvals directory at ${this.dir}`);
    }
    console.log(`[approvals] loaded ${this.cache.size} approval(s)`);
  }

  /** Get approval for a skill */
  get(skill: string): SkillApproval | null {
    return this.cache.get(skill) ?? null;
  }

  /** Check if a skill has a specific capability approved */
  hasCapability(skill: string, capability: string): boolean {
    const approval = this.get(skill);
    if (!approval) return false;
    return approval.capabilities.some((c) => c.capability === capability);
  }

  /** Get the scope for a specific capability */
  getScope(skill: string, capability: string): string[] | undefined {
    const approval = this.get(skill);
    if (!approval) return undefined;
    const cap = approval.capabilities.find((c) => c.capability === capability);
    return cap?.scope;
  }
}
