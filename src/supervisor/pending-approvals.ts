import { randomUUID } from "node:crypto";
import type { SkillCapability } from "./types.js";

interface PendingEntry {
  token: string;
  skill: string;
  version: string;
  capabilities: SkillCapability[];
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Stores in-flight approval requests that are awaiting a human reply
 * via the OpenClaw chat channel.
 *
 * Timeout is 4 minutes — safely under the plugin's 300s IPC timeout.
 */
export class PendingApprovalStore {
  private store = new Map<string, PendingEntry>();

  /** Enqueue a new approval request and return the token + a promise to await. */
  enqueue(
    skill: string,
    version: string,
    capabilities: SkillCapability[]
  ): { token: string; promise: Promise<boolean> } {
    const token = `apr_${randomUUID().slice(0, 8)}`;

    const promise = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.store.has(token)) {
          this.store.delete(token);
          reject(new Error("Approval timed out"));
        }
      }, 4 * 60 * 1000); // 4 minutes

      this.store.set(token, {
        token,
        skill,
        version,
        capabilities,
        resolve,
        reject,
        timer,
      });
    });

    return { token, promise };
  }

  /** Resolve a pending approval by token. */
  resolve(token: string, approved: boolean): void {
    const entry = this.store.get(token);
    if (!entry) {
      console.warn(`[pending-approvals] unknown token: ${token}`);
      return;
    }
    clearTimeout(entry.timer);
    this.store.delete(token);
    entry.resolve(approved);
  }

  /** List all pending approvals (for dashboard API). */
  getPending(): Array<{ token: string; skill: string; capabilities: SkillCapability[] }> {
    return Array.from(this.store.values()).map(({ token, skill, capabilities }) => ({
      token,
      skill,
      capabilities,
    }));
  }
}
