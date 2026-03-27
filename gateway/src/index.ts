import { getConfig } from "./config.js";
import { SignalChannel } from "./channels/signal.js";
import { handleMessage, type AgentConfig } from "./agent/loop.js";
import { Store } from "./store/sqlite.js";
import { NomadEventPoller } from "./webhooks/nomad-events.js";
import { WebhookServer } from "./webhooks/server.js";
import { join } from "node:path";

const config = getConfig();

// --- Store ---
const store = new Store(join(config.data_dir, "gateway.db"));

// --- Agent config ---
const agentConfig: AgentConfig = {
  inference: {
    apiKey: config.openrouter_api_key,
    model: config.openrouter_model,
  },
};

// --- Signal channel ---
const signal = new SignalChannel({
  cliUrl: config.signal_cli_url,
  account: config.signal_account,
  allowedNumbers: config.signal_allowed_numbers,
});

// Track which channel dispatched which job (for notifications)
let lastChannelId: string | null = null;

signal.onMessage(async (msg) => {
  console.log(`[gateway] <- ${msg.userId}: ${msg.text}`);
  lastChannelId = msg.channelId;

  try {
    const history = store.getHistory(msg.channelId, 20);
    const { reply, messages } = await handleMessage(agentConfig, history, msg.text);

    // Persist conversation
    // Only save user message + final assistant reply (skip intermediate tool calls for cleaner history)
    store.saveMessages(msg.channelId, [
      { role: "user", content: msg.text },
      { role: "assistant", content: reply },
    ]);

    // Check if any tool calls dispatched a job — map it for notifications
    for (const m of messages) {
      if (m.role === "tool" && m.content) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed.status === "dispatched" && parsed.job_id) {
            store.mapDispatch(parsed.job_id, msg.channelId, msg.channelType, msg.userId);
            console.log(`[gateway] mapped job ${parsed.job_id} -> ${msg.channelId}`);
          }
          if (parsed.status === "continued" && parsed.job_id) {
            store.mapDispatch(parsed.job_id, msg.channelId, msg.channelType, msg.userId);
          }
        } catch {
          // Not JSON or not a dispatch result — skip
        }
      }
    }

    await signal.send({ channelType: "signal", channelId: msg.channelId, text: reply });
    console.log(`[gateway] -> ${msg.channelId}: ${reply.slice(0, 80)}...`);
  } catch (err) {
    console.error("[gateway] error handling message:", err);
    await signal.send({
      channelType: "signal",
      channelId: msg.channelId,
      text: "Sorry, something went wrong processing your message.",
    }).catch(console.error);
  }
});

// --- Nomad event poller ---
const poller = new NomadEventPoller(15000);

poller.onJobEvent(async (event) => {
  const mapping = store.getDispatchChannel(event.jobId);
  const channelId = mapping?.channelId ?? lastChannelId;

  if (!channelId) {
    console.log(`[gateway] job ${event.jobId} completed but no channel to notify`);
    return;
  }

  const emoji = event.status === "complete" || event.status === "dead" ? "✓" : "✗";
  const statusText = event.status === "dead" ? "completed" : event.status;
  const text = `${emoji} Job ${statusText}: ${event.project} (${event.runtime})\nJob ID: ${event.jobId.slice(-20)}`;

  try {
    await signal.send({ channelType: "signal", channelId, text });
    console.log(`[gateway] notified ${channelId} about ${event.jobId}`);
  } catch (err) {
    console.error("[gateway] notification send failed:", err);
  }
});

// --- Webhook server ---
const webhookServer = new WebhookServer({
  port: config.webhook_port,
  token: process.env["WEBHOOK_TOKEN"],
});

webhookServer.onWebhook((payload) => {
  console.log("[gateway] webhook received:", JSON.stringify(payload).slice(0, 200));
  // Future: route webhook payloads to the agent loop
});

// --- Boot ---
async function main() {
  console.log("[gateway] starting...");
  console.log(`[gateway] signal account: ${config.signal_account}`);
  console.log(`[gateway] nomad: ${config.nomad_addr}`);
  console.log(`[gateway] model: ${config.openrouter_model}`);

  await webhookServer.start();
  await signal.start();
  poller.start();

  console.log("[gateway] ready");
}

// --- Shutdown ---
function shutdown() {
  console.log("[gateway] shutting down...");
  poller.stop();
  signal.stop().catch(console.error);
  webhookServer.stop().catch(console.error);
  store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
