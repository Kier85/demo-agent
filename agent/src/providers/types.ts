// Provider-neutral chat format. Adapters translate this to and from each
// vendor's wire format; the agent loop never sees vendor types.

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments. `undefined` when the model produced invalid JSON. */
  args: Record<string, unknown> | undefined;
  /** Raw argument string, kept for traces when parsing failed. */
  rawArgs?: string;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: { callId: string; name: string; content: string }[] };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface CompletionResponse {
  text?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Vendor stop reason, normalised to lower case. */
  stopReason: string;
}

export interface LLMProvider {
  /** Short id used in config, traces and the kill switch: anthropic | openai | xai | mock */
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
