import { chatCompletion, type Message, type InferenceConfig } from "./inference.ts";
import { toolDefs, executeTool } from "./tools.ts";

const SYSTEM_PROMPT_PATH = new URL("../../SYSTEM.md", import.meta.url).pathname;

let systemPrompt: string;
try {
  systemPrompt = Deno.readTextFileSync(SYSTEM_PROMPT_PATH);
} catch {
  systemPrompt = "You are a personal assistant with tools for meals, home automation, news, and coding fleet management.";
}

const MAX_TOOL_ROUNDS = 5;

export interface AgentConfig {
  inference: InferenceConfig;
}

export async function handleMessage(
  config: AgentConfig,
  history: Message[],
  userText: string
): Promise<{ reply: string; messages: Message[] }> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt.replace("{time}", new Date().toISOString()) },
    ...history,
    { role: "user", content: userText },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await chatCompletion(config.inference, messages, toolDefs);

    if (response.toolCalls.length === 0) {
      const reply = response.content ?? "I'm not sure how to help with that.";
      messages.push({ role: "assistant", content: reply });
      return {
        reply,
        messages: messages.filter((m) => m.role !== "system"),
      };
    }

    // Assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: response.toolCalls,
    });

    // Execute each tool call and add results
    for (const call of response.toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
      }

      console.log(`[agent] tool: ${call.function.name}(${JSON.stringify(args)})`);
      const result = await executeTool(call.function.name, args);

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: call.id,
      });
    }
  }

  // Exhausted tool rounds — ask the LLM to summarize
  const finalResponse = await chatCompletion(config.inference, [
    ...messages,
    { role: "user", content: "Please summarize the results above in a concise response." },
  ]);

  const reply = finalResponse.content ?? "I completed several actions but couldn't summarize them.";
  messages.push({ role: "assistant", content: reply });
  return {
    reply,
    messages: messages.filter((m) => m.role !== "system"),
  };
}
