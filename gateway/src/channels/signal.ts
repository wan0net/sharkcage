import type { Channel, InboundMessage, OutboundMessage } from "./types.js";

interface SignalConfig {
  cliUrl: string;
  account: string;
  allowedNumbers: string[];
}

export class SignalChannel implements Channel {
  name = "signal";
  private config: SignalConfig;
  private handler: ((msg: InboundMessage) => void) | null = null;
  private abortController: AbortController | null = null;

  constructor(config: SignalConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    this.listenSSE().catch((err) => {
      console.error("[signal] SSE connection error:", err);
      // Reconnect after delay
      setTimeout(() => {
        if (this.abortController && !this.abortController.signal.aborted) {
          this.listenSSE().catch(() => {});
        }
      }, 5000);
    });
    console.log("[signal] adapter started");
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    console.log("[signal] adapter stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      method: "send",
      id: Date.now(),
      params: {
        account: this.config.account,
        recipient: [msg.channelId],
        message: msg.text,
      },
    };

    const res = await fetch(`${this.config.cliUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`signal-cli send failed: ${res.status} ${text}`);
    }
  }

  private async listenSSE(): Promise<void> {
    const res = await fetch(`${this.config.cliUrl}/api/v1/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.abortController?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const event = JSON.parse(data);
          this.handleEvent(event);
        } catch {
          // skip malformed events
        }
      }
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (!this.handler) return;

    // signal-cli wraps messages in an envelope
    const envelope = (event.envelope ?? event) as Record<string, unknown>;
    const dataMessage = envelope.dataMessage as Record<string, unknown> | undefined;
    if (!dataMessage?.message) return;

    const source = String(envelope.source ?? envelope.sourceNumber ?? "");
    if (!source) return;

    // Only accept messages from allowed numbers
    if (this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(source)) {
      console.log(`[signal] ignored message from unauthorized number: ${source}`);
      return;
    }

    const msg: InboundMessage = {
      channelType: "signal",
      channelId: source,
      userId: source,
      userName: String(envelope.sourceName ?? source),
      text: String(dataMessage.message),
      timestamp: new Date(Number(envelope.timestamp ?? Date.now())),
    };

    this.handler(msg);
  }
}
