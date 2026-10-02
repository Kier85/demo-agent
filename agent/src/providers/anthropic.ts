import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from "./types.ts";

type AnthropicMessage = Anthropic.MessageParam;

/** Neutral messages -> Anthropic Messages API format. Exported for tests. */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  return messages.map((m): AnthropicMessage => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant": {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: r.content })),
        };
    }
  });
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { apiKey: string; model: string; baseURL?: string }) {
    this.model = opts.model;
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: 60_000 });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return {
      text: text || undefined,
      toolCalls: res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> })),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      stopReason: String(res.stop_reason ?? "unknown").toLowerCase(),
    };
  }
}
