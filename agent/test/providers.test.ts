import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import { toChatMessages } from "../src/providers/openai.ts";
import { costUsd } from "../src/providers/pricing.ts";
import { parseArgs, type Message } from "../src/providers/types.ts";
import { toolSpecs } from "../src/tools/definitions.ts";

const convo: Message[] = [
  { role: "user", content: "Where is SM-1001?" },
  { role: "assistant", text: "Checking.", toolCalls: [{ id: "c1", name: "getOrder", args: { orderId: "SM-1001", reason: "look" } }] },
  { role: "tool", results: [{ callId: "c1", name: "getOrder", content: '{"ok":true}' }] },
];

describe("provider adapters", () => {
  it("maps the neutral format to Anthropic content blocks", () => {
    const m = toAnthropicMessages(convo);
    expect(m[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "c1", name: "getOrder", input: { orderId: "SM-1001", reason: "look" } },
      ],
    });
    expect(m[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] });
  });

  it("maps the neutral format to OpenAI / xAI chat messages", () => {
    const m = toChatMessages("sys", convo);
    expect(m[0]).toEqual({ role: "system", content: "sys" });
    expect(m[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "getOrder", arguments: '{"orderId":"SM-1001","reason":"look"}' } }],
    });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
  });

  it("replays unparseable arguments verbatim to OpenAI", () => {
    const m = toChatMessages("s", [{ role: "assistant", toolCalls: [{ id: "x", name: "getOrder", args: undefined, rawArgs: "{oops" }] }]);
    expect(m[1]).toMatchObject({ tool_calls: [{ function: { arguments: "{oops" } }] });
  });

  it("parses tool arguments defensively", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs("")).toEqual({});
    expect(parseArgs("[1]")).toBeUndefined();
    expect(parseArgs("{bad")).toBeUndefined();
  });
});

describe("tool specs", () => {
  it("exposes JSON Schemas with required reason and no identity fields", () => {
    for (const t of toolSpecs) {
      const p = t.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(p.type).toBe("object");
      expect(p.required).toContain("reason");
      expect(Object.keys(p.properties)).not.toContain("customerEmail");
      expect(Object.keys(p.properties)).not.toContain("ticketId");
      expect(t.parameters).not.toHaveProperty("$schema");
    }
    expect(toolSpecs.map((t) => t.name)).toEqual([
      "getOrder", "getShipment", "updateShippingAddress", "createReorder", "escalateToHuman", "respondToCustomer",
    ]);
  });
});

describe("pricing", () => {
  it("computes cost from list prices", () => {
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3);
    expect(costUsd("grok-4.3", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(3.75);
    expect(costUsd("unknown-model", { inputTokens: 5, outputTokens: 5 })).toBe(0);
  });
});
