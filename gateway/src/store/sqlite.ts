import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../agent/inference.js";

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dispatch_map (
        job_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'signal',
        user_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_channel ON dispatch_map(channel_id);
    `);
  }

  getHistory(channelId: string, limit = 20): Message[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, tool_calls, tool_call_id
         FROM messages
         WHERE channel_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(channelId, limit) as Array<{
        role: string;
        content: string;
        tool_calls: string | null;
        tool_call_id: string | null;
      }>;

    return rows.reverse().map((row) => {
      const msg: Message = {
        role: row.role as Message["role"],
        content: row.content,
      };
      if (row.tool_calls) {
        msg.tool_calls = JSON.parse(row.tool_calls);
      }
      if (row.tool_call_id) {
        msg.tool_call_id = row.tool_call_id;
      }
      return msg;
    });
  }

  saveMessages(channelId: string, messages: Message[]): void {
    const insert = this.db.prepare(
      `INSERT INTO messages (channel_id, role, content, tool_calls, tool_call_id)
       VALUES (?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction((msgs: Message[]) => {
      for (const msg of msgs) {
        insert.run(
          channelId,
          msg.role,
          msg.content ?? "",
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.tool_call_id ?? null
        );
      }
    });

    tx(messages);
  }

  mapDispatch(jobId: string, channelId: string, channelType: string, userId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dispatch_map (job_id, channel_id, channel_type, user_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(jobId, channelId, channelType, userId);
  }

  getDispatchChannel(jobId: string): { channelId: string; channelType: string; userId: string } | null {
    const row = this.db
      .prepare(`SELECT channel_id, channel_type, user_id FROM dispatch_map WHERE job_id = ?`)
      .get(jobId) as { channel_id: string; channel_type: string; user_id: string } | undefined;

    if (!row) return null;
    return { channelId: row.channel_id, channelType: row.channel_type, userId: row.user_id };
  }

  close(): void {
    this.db.close();
  }
}
