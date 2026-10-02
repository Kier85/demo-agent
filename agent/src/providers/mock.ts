import type { CompletionRequest, CompletionResponse, LLMProvider, Message, ToolCall } from "./types.ts";

/**
 * A rule-based stand-in for an LLM: keyword intent detection plus a fixed
 * decision tree. It speaks the same tool-calling protocol, so it exercises
 * the real loop, executor, API and eval offline and in CI, and gives the
 * real models a "no-LLM baseline" to beat. It is not an LLM.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly model = "mock";
  private counter = 0;

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const first = req.messages[0];
    const raw = first?.role === "user" ? first.content : "";
    const text = raw.match(/<customer_message>([\s\S]*)<\/customer_message>/)?.[1]?.trim() ?? raw;
    const [name, args] = decide(text, history(req.messages));
    const call: ToolCall = { id: `mock_${++this.counter}`, name, args: { ...args, reason: args.reason ?? `rule: ${name}` } };
    return { toolCalls: [call], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "tool_use" };
  }
}

interface Done {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  data: any;
}

function history(messages: Message[]): Done[] {
  const out: Done[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const next = messages[i + 1];
    for (const c of m.toolCalls) {
      const r = next?.role === "tool" ? next.results.find((x) => x.callId === c.id) : undefined;
      const parsed = r ? JSON.parse(r.content) : { ok: false };
      out.push({ name: c.name, args: c.args ?? {}, ok: parsed.ok, data: parsed.ok ? parsed.data : parsed.error });
    }
  }
  return out;
}

const RX = {
  money: /refund|money back|chargeback|reimburs|compensat|discount|credit/i,
  damaged: /damag|misprint|broken|smudg|wrong colou?r|faded|peeling|blurry|look(s|ed)? (weird|off)/i,
  address: /address|ship (it )?to|send (it )?to|moved/i,
  reorder: /reorder|re-order|order (the same|again|more)|another (batch|run)|same (as|again)|more of/i,
  notReceived: /(never|haven'?t|didn'?t|not)\s+(got|gotten|received|arrived?|get)/i,
  address1: /(\d+[^,\n]*?),\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5})/,
};

type Action = [string, Record<string, unknown>];

const reply = (message: string, outcome: "resolved" | "needs_info", reason: string): Action => [
  "respondToCustomer",
  { message, outcome, reason },
];

function decide(text: string, done: Done[]): Action {
  const last = (name: string) => [...done].reverse().find((d) => d.name === name);
  const escalation = last("escalateToHuman");
  if (escalation?.ok) {
    return reply("Thanks, I've passed this to our support team and a person will follow up shortly.", "resolved", "escalated to a human");
  }
  const escalate = (category: string, reason: string, orderId?: string): Action =>
    escalation ? reply("Thanks, a member of our team will follow up.", "resolved", "escalation failed; replying anyway")
      : ["escalateToHuman", { category, reason, summary: text.slice(0, 300), ...(orderId && { orderId }) }];

  const orderId = text.match(/SM-\d{4}/)?.[0];
  if (!orderId) {
    if (RX.money.test(text)) return escalate("REFUND", "customer asks for money back without an order number");
    return reply("Happy to help! Could you send me your order number? It looks like SM-1234.", "needs_info", "no order id in ticket");
  }

  const order = last("getOrder");
  if (!order) return ["getOrder", { orderId, reason: "look up the order mentioned in the ticket" }];
  if (!order.ok) return reply(`I couldn't find order ${orderId} on your account. Could you double-check the number?`, "needs_info", "order not found");
  const o = order.data;

  if (RX.money.test(text)) return escalate("REFUND", "customer is asking for a refund, credit or discount", orderId);
  if (RX.damaged.test(text)) return escalate("DAMAGED_OR_MISPRINT", "customer reports damaged or misprinted items", orderId);

  if (RX.address.test(text)) {
    if (!o.canChangeAddress) return escalate("POLICY_EXCEPTION", `address change requested but order is ${o.status}`, orderId);
    const update = last("updateShippingAddress");
    if (update) return update.ok ? reply(`Done! Order ${orderId} will ship to the new address.`, "resolved", "address updated")
      : escalate("POLICY_EXCEPTION", "address update was refused", orderId);
    const m = text.replace(/SM-\d{4}/g, "").match(RX.address1);
    if (!m) return reply("I can change that. Please send the full new address including the ZIP code.", "needs_info", "address incomplete");
    return ["updateShippingAddress", {
      orderId,
      address: { name: o.shippingAddress.name, line1: m[1]!.trim(), city: m[2]!.trim(), region: m[3], postalCode: m[4], country: "US" },
    }];
  }

  if (RX.reorder.test(text)) {
    const re = last("createReorder");
    if (re) return re.ok ? reply(`Your reorder ${re.data.id} is placed and will go to proof shortly.`, "resolved", "reorder created")
      : escalate("POLICY_EXCEPTION", `reorder refused: ${re.data?.message ?? "see tool result"}`, orderId);
    return ["createReorder", { orderId, ...reorderItems(text, o.items) }];
  }

  const ship = last("getShipment");
  if (!ship) return ["getShipment", { orderId, reason: "check tracking" }];
  const s = ship.data;
  if (!s || s.shipped === false) return reply(`Order ${orderId} is ${String(o.status).toLowerCase().replace("_", " ")} and hasn't shipped yet.`, "resolved", "not shipped yet");
  if (s.status === "EXCEPTION") return escalate("LOST_OR_DELAYED", "carrier reports a delivery exception", orderId);
  if (s.status !== "DELIVERED" && new Date(s.estimatedDelivery) < new Date()) return escalate("LOST_OR_DELAYED", "shipment is past its estimated delivery date", orderId);
  if (s.status === "DELIVERED" && RX.notReceived.test(text)) return escalate("LOST_OR_DELAYED", "carrier says delivered but customer did not receive it", orderId);
  return reply(`Order ${orderId} is ${s.status.toLowerCase().replaceAll("_", " ")} with ${s.carrier} (tracking ${s.trackingNumber}).`, "resolved", "reported tracking status");
}

function reorderItems(text: string, items: { sku: string; product: string; quantity: number }[]): Record<string, unknown> {
  if (/double/i.test(text)) return { items: items.map((i) => ({ sku: i.sku, quantity: i.quantity * 2 })) };
  const n = text.replace(/SM-\d{4}/g, "").match(/\b(\d{1,3}(?:,\d{3})+|\d{2,6})\b/)?.[1];
  if (!n) return {};
  const qty = Number(n.replaceAll(",", ""));
  const named = items.find((i) => text.toLowerCase().includes(i.product.toLowerCase().split(" ")[0]!.replace(/s$/, "")));
  const target = named ?? (items.length === 1 ? items[0] : undefined);
  return target ? { items: [{ sku: target.sku, quantity: qty }] } : {};
}
