/**
 * IPC client for communicating with the sharkcage supervisor via unix socket.
 * Newline-delimited JSON protocol (JSONL).
 */

import { connect, Socket } from "node:net";

interface ToolCallRequest {
  id: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
}

interface SandboxViolation {
  type: "network" | "filesystem" | "exec";
  target: string;
  detail: string;
}

interface ToolCallResponse {
  id: string;
  result: string;
  error?: string;
  durationMs: number;
  violation?: SandboxViolation;
}

export class SupervisorClient {
  private socketPath: string;
  private conn: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, {
    resolve: (r: ToolCallResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 0;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn = connect({ path: this.socketPath }, () => {
        console.log(`[sharkcage-plugin] connected to supervisor at ${this.socketPath}`);
        this.setupHandlers();
        resolve();
      });

      this.conn.on("error", (err) => {
        this.conn = null;
        reject(err);
      });
    });
  }

  private setupHandlers(): void {
    if (!this.conn) return;

    this.conn.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as ToolCallResponse;
          const p = this.pending.get(response.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(response.id);
            p.resolve(response);
          }
        } catch {
          console.error("[sharkcage-plugin] bad response:", line.slice(0, 100));
        }
      }
    });

    this.conn.on("end", () => {
      for (const { reject: rej, timer } of this.pending.values()) {
        clearTimeout(timer);
        rej(new Error("Connection closed"));
      }
      this.pending.clear();
    });
  }

  async call(skill: string, tool: string, args: Record<string, unknown>): Promise<ToolCallResponse> {
    if (!this.conn) throw new Error("Not connected to supervisor");

    const id = `tc_${++this.nextId}_${Date.now()}`;
    const request: ToolCallRequest = { id, skill, tool, args };

    return new Promise<ToolCallResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Tool call timed out: ${skill}/${tool}`));
        }
      }, 300_000);

      this.pending.set(id, { resolve, reject, timer });

      const line = JSON.stringify(request) + "\n";
      this.conn!.write(line, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
          }
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.conn?.destroy();
    this.conn = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }
}
