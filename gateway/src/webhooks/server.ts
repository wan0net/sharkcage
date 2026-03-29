export interface WebhookConfig {
  port: number;
  token?: string;
}

type WebhookHandler = (payload: Record<string, unknown>) => void;

export class WebhookServer {
  private config: WebhookConfig;
  private handler: WebhookHandler | null = null;
  private controller: AbortController | null = null;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  onWebhook(handler: WebhookHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.controller = new AbortController();

    Deno.serve(
      {
        port: this.config.port,
        signal: this.controller.signal,
        onListen: ({ port }) => {
          console.log(`[webhook] listening on :${port}`);
        },
      },
      (req) => this.handleRequest(req)
    );
  }

  stop(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    return Promise.resolve();
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    if (url.pathname === "/hooks/wake" && req.method === "POST") {
      if (this.config.token) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${this.config.token}`) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      try {
        const payload = (await req.json()) as Record<string, unknown>;
        this.handler?.(payload);
        return Response.json({ accepted: true });
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
}
