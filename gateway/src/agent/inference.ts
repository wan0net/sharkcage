export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface InferenceConfig {
  apiKey: string;
  model: string;
}

export interface CompletionResponse {
  content: string | null;
  toolCalls: ToolCall[];
}

export async function chatCompletion(
  config: InferenceConfig,
  messages: Message[],
  tools?: ToolDef[]
): Promise<CompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: 2048,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "HTTP-Referer": "https://github.com/wan0net/yeet",
      "X-Title": "yeet-gateway",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
  };

  const choice = data.choices[0];
  if (!choice) throw new Error("OpenRouter returned no choices");

  return {
    content: choice.message.content,
    toolCalls: choice.message.tool_calls ?? [],
  };
}
