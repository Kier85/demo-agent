import type { CompletionRequest, CompletionResponse, LLMProvider, ToolCall } from "../src/providers/types.ts";
import { ShopClient, type Transport } from "../src/shop.ts";

export interface Recorded {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * In-memory stand-in for the Go API. It mimics the API's ownership and
 * production-status rules so executor tests can check that refusals are
 * surfaced correctly; the real rules are tested in Go.
 */
export function fakeShop(opts: { agentEnabled?: boolean } = {}) {
  const calls: Recorded[] = [];
  const orders: Record<string, { owner: string; status: string; canChangeAddress: boolean }> = {
    "SM-1001": { owner: "alice@example.com", status: "SHIPPED", canChangeAddress: false },
    "SM-1009": { owner: "alice@example.com", status: "PROOF_PENDING", canChangeAddress: true },
    "SM-1014": { owner: "alice@example.com", status: "DELIVERED", canChangeAddress: false },
  };
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const fail = (field: string, code: string, message: string) =>
    new Response(JSON.stringify({ data: { [field]: null }, errors: [{ message, extensions: { code } }] }), { status: 200 });

  const transport: Transport = async (url, init) => {
    if (String(url).endsWith("/admin/reset")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    calls.push({ query: body.query, variables: body.variables, headers });
    const email = headers["x-customer-email"];
    const q: string = body.query;
    const v = body.variables;
    const owned = (id: string) => (orders[id]?.owner === email ? orders[id] : undefined);

    if (q.includes("agentStatus")) return ok({ agentStatus: { provider: v.p, enabled: opts.agentEnabled ?? true, reason: "test" } });
    if (q.includes("updateShippingAddress")) {
      const o = owned(v.id);
      if (!o) return fail("updateShippingAddress", "NOT_FOUND", "order not found");
      if (!o.canChangeAddress) return fail("updateShippingAddress", "POLICY_VIOLATION", "address can only be changed before production");
      return ok({ updateShippingAddress: { id: v.id, shippingAddress: v.a } });
    }
    if (q.includes("createReorder")) {
      if (!owned(v.id)) return fail("createReorder", "NOT_FOUND", "order not found");
      return ok({ createReorder: { id: "SM-2001", reorderOf: v.id, key: v.key } });
    }
    if (q.includes("escalateToHuman")) return ok({ escalateToHuman: { id: "ESC-1", category: v.in.category, reason: v.in.reason } });
    if (q.includes("shipment(")) return ok({ shipment: owned(v.id) ? { orderId: v.id, status: "IN_TRANSIT" } : null });
    if (q.includes("order(")) {
      const o = owned(v.id);
      return ok({ order: o ? { id: v.id, status: o.status, canChangeAddress: o.canChangeAddress, items: [{ sku: "DC-3X3", quantity: 200 }] } : null });
    }
    throw new Error(`unexpected query ${q}`);
  };
  const shop = new ShopClient({ url: "http://fake", apiToken: "t" }, transport);
  return { shop, calls, orders };
}

let n = 0;
export function call(name: string, args: Record<string, unknown> | undefined): ToolCall {
  return { id: `c${++n}`, name, args };
}

/** Provider that replays a fixed script of turns, one per complete() call. */
export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly model = "claude-sonnet-5-5";
  requests: CompletionRequest[] = [];
  private turns: (ToolCall[] | string | Error)[];

  constructor(turns: (ToolCall[] | string | Error)[]) {
    this.turns = turns;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(req));
    const t = this.turns.shift();
    if (t === undefined) return { toolCalls: [call("getOrder", { orderId: "SM-1001", reason: "loop forever" })], usage: { inputTokens: 100, outputTokens: 10 }, stopReason: "tool_use" };
    if (t instanceof Error) throw t;
    if (typeof t === "string") return { text: t, toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 }, stopReason: "end_turn" };
    return { toolCalls: t, usage: { inputTokens: 1000, outputTokens: 50 }, stopReason: "tool_use" };
  }
}
