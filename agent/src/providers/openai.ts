import OpenAI from "openai";
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from "./types.ts";
import { parseArgs } from "./types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Neutral messages -> Chat Completions format. Exported for tests. */
export function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: m.text ?? null,
          ...(m.toolCalls.length > 0 && {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) },
            })),
          }),
        });
        break;
      case "tool":
        for (const r of m.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
        break;
    }
  }
  return out;
}

/**
 * Chat Completions adapter. Serves both OpenAI and xAI Grok, whose API is
 * OpenAI-compatible: only the base URL, key and model differ.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: { name: "openai" | "xai"; apiKey: string; model: string; baseURL?: string }) {
    this.name = opts.name;
    this.model = opts.model;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: 60_000 });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: toChatMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      max_completion_tokens: 4096,
    });
    const choice = res.choices[0];
    const msg = choice?.message;
    const toolCalls = (msg?.tool_calls ?? [])
      .filter((c) => c.type === "function")
      .map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments), rawArgs: c.function.arguments }));
    return {
      text: msg?.content?.trim() || undefined,
      toolCalls,
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      stopReason: String(choice?.finish_reason ?? "unknown").toLowerCase(),
    };
  }
}
