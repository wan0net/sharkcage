import { randomUUID } from "node:crypto";
import type { SkillCapability, TokenEntry } from "./types.js";

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Issues short-lived tokens that map to skill identity + capabilities.
 * Used as the SOCKS5 username so the proxy can enforce per-skill allowlists.
 */
export class TokenRegistry {
  private entries = new Map<string, TokenEntry>();

  issue(skill: string, capabilities: SkillCapability[]): string {
    const token = randomUUID();
    const timeoutHandle = setTimeout(() => {
      this.entries.delete(token);
    }, TOKEN_TTL_MS);

    // Allow the timer to be garbage-collected if the process exits
    if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
      (timeoutHandle as NodeJS.Timeout).unref();
    }

    this.entries.set(token, {
      skill,
      capabilities,
      issuedAt: Date.now(),
      timeoutHandle,
    });

    return token;
  }

  lookup(token: string): { skill: string; capabilities: SkillCapability[] } | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    return { skill: entry.skill, capabilities: entry.capabilities };
  }

  revoke(token: string): void {
    const entry = this.entries.get(token);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      this.entries.delete(token);
    }
  }
}
