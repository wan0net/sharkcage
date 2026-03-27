import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface WebhookConfig {
  port: number;
  token?: string;
}

type WebhookHandler = (payload: Record<string, unknown>) => void;

export class WebhookServer {
  private config: WebhookConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private handler: WebhookHandler | null = null;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  onWebhook(handler: WebhookHandler): void {
    this.handler = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.config.port, () => {
        console.log(`[webhook] listening on :${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    if (url === "/hooks/wake" && req.method === "POST") {
      // Token auth
      if (this.config.token) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${this.config.token}`) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as Record<string, unknown>;
          this.handler?.(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        } catch {
          res.writeHead(400);
          res.end("Bad Request");
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  }
}
