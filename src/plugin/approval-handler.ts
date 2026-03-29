import type { ApprovalRequest, ApprovalResponse, SkillCapability } from "../supervisor/types.js";
import type { SupervisorClient } from "./ipc.js";

/**
 * Handles approval requests by posting a message to the active OpenClaw
 * chat channel and listening for a human reply (`sc yes <token>` / `sc no <token>`).
 */
export class ApprovalHandler {
  private openclawPort: number;
  private supervisor: SupervisorClient;
  private pendingTokens = new Set<string>();

  constructor(openclawPort: number = 18789, supervisor: SupervisorClient) {
    this.openclawPort = openclawPort;
    this.supervisor = supervisor;
  }

  /** Called when the supervisor sends an approval.request IPC message. */
  async handleApprovalRequest(req: ApprovalRequest): Promise<void> {
    const capLines = req.capabilities
      .map((c: SkillCapability) => `  • ${c.capability} — ${c.reason}`)
      .join("\n");

    const message =
      `⚠️ Skill "${req.skill}" (v${req.version}) is requesting approval for:\n` +
      `${capLines}\n` +
      `Reply \`sc yes ${req.token}\` to approve or \`sc no ${req.token}\` to deny.`;

    this.pendingTokens.add(req.token);

    try {
      const res = await fetch(
        `http://127.0.0.1:${this.openclawPort}/api/channels/active/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message }),
        }
      );

      if (!res.ok) {
        console.error(
          `[sharkcage-approval] failed to send approval request to OpenClaw: ${res.status}`
        );
        this.pendingTokens.delete(req.token);
        this.supervisor.sendResponse({
          type: "approval.response",
          token: req.token,
          approved: false,
        });
      }
    } catch (err) {
      console.error("[sharkcage-approval] error posting to OpenClaw channel:", err);
      this.pendingTokens.delete(req.token);
      this.supervisor.sendResponse({
        type: "approval.response",
        token: req.token,
        approved: false,
      });
    }
  }

  /** Check whether an inbound message text is an approval reply command. */
  checkReply(messageText: string): { matched: boolean; token?: string; approved?: boolean } {
    const match = messageText.trim().match(/^sc\s+(yes|no)\s+(apr_[a-z0-9]+)$/i);
    if (!match) return { matched: false };

    const approved = match[1].toLowerCase() === "yes";
    const token = match[2].toLowerCase();
    return { matched: true, token, approved };
  }

  /** Route a matched reply back to the supervisor. */
  handleInboundReply(token: string, approved: boolean): void {
    if (!this.pendingTokens.has(token)) {
      console.warn(`[sharkcage-approval] reply for unknown token: ${token}`);
      return;
    }
    this.pendingTokens.delete(token);
    this.supervisor.sendResponse({
      type: "approval.response",
      token,
      approved,
    });
  }
}
