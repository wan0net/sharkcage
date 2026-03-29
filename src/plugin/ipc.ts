/**
 * IPC client for communicating with the sharkcage supervisor via unix socket.
 * Newline-delimited JSON protocol (JSONL).
 */

import { connect, type Socket } from "node:net";
import type { ApprovalRequest, ApprovalResponse } from "../supervisor/types.js";

interface ToolCallRequest {
  id: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolCallResponse {
  id: string;
  result: string;
  error?: string;
  durationMs: number;
}

export class SupervisorClient {
  private socketPath: string;
  private conn: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, {
    resolve: (r: ToolCallResponse) => void;
    reject: (e: Error) => void;
  }>();
  private nextId = 0;
  private approvalRequestHandler: ((req: ApprovalRequest) => void) | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn = connect({ path: this.socketPath }, () => {
        console.log(`[sharkcage-plugin] connected to supervisor at ${this.socketPath}`);
        resolve();
      });

      this.conn.on("error", (err) => {
        if (this.pending.size === 0) reject(err);
      });

      this.conn.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { type?: string } & ToolCallResponse & ApprovalRequest;
            if (parsed.type === "approval.request") {
              if (this.approvalRequestHandler) {
                this.approvalRequestHandler(parsed as ApprovalRequest);
              } else {
                console.warn("[sharkcage-plugin] received approval.request but no handler registered");
              }
            } else {
              const response = parsed as ToolCallResponse;
              const p = this.pending.get(response.id);
              if (p) {
                this.pending.delete(response.id);
                p.resolve(response);
              }
            }
          } catch {
            console.error("[sharkcage-plugin] bad response:", line.slice(0, 100));
          }
        }
      });

      this.conn.on("end", () => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error("Connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  async call(skill: string, tool: string, args: Record<string, unknown>): Promise<ToolCallResponse> {
    if (!this.conn) throw new Error("Not connected to supervisor");

    const id = `tc_${++this.nextId}_${Date.now()}`;
    const request: ToolCallRequest = { id, skill, tool, args };

    return new Promise<ToolCallResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const line = JSON.stringify(request) + "\n";
      this.conn!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Tool call timed out: ${skill}/${tool}`));
        }
      }, 300_000);
    });
  }

  /** Register a handler for inbound approval.request messages from the supervisor. */
  onApprovalRequest(handler: (req: ApprovalRequest) => void): void {
    this.approvalRequestHandler = handler;
  }

  /** Fire-and-forget: send an ApprovalResponse back to the supervisor. */
  sendResponse(msg: ApprovalResponse): void {
    if (!this.conn) {
      console.warn("[sharkcage-plugin] sendResponse: not connected");
      return;
    }
    this.conn.write(JSON.stringify(msg) + "\n");
  }

  close(): void {
    this.conn?.destroy();
    this.conn = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }
}
