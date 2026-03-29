import { Database } from "@db/sqlite";
import type { Message } from "../agent/inference.ts";

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) {
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch {
        // directory may already exist
      }
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
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

    this.db.exec("BEGIN");
    try {
      for (const msg of messages) {
        insert.run(
          channelId,
          msg.role,
          msg.content ?? "",
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.tool_call_id ?? null
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
    const rows = this.db
      .prepare(`SELECT channel_id, channel_type, user_id FROM dispatch_map WHERE job_id = ?`)
      .all(jobId) as Array<{ channel_id: string; channel_type: string; user_id: string }>;

    if (!rows.length) return null;
    const row = rows[0];
    return { channelId: row.channel_id, channelType: row.channel_type, userId: row.user_id };
  }

  close(): void {
    this.db.close();
  }
}
