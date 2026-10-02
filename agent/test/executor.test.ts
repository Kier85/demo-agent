import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools/executor.ts";
import { call, fakeShop } from "./fakes.ts";

const addr = { name: "Alice Moreno", line1: "500 Folsom St", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" };
const why = "customer asked for it";

function setup() {
  const fake = fakeShop();
  const ex = new ToolExecutor({ shop: fake.shop, customerEmail: "alice@example.com", ticketId: "T-1" });
  return { ...fake, ex };
}

describe("ToolExecutor guardrails", () => {
  it("injects the verified customer and never takes identity from the model", async () => {
    const { ex, calls } = setup();
    const r = await ex.execute(call("getOrder", { orderId: "SM-1009", reason: why, customerEmail: "mallory@example.com" }));
    expect(r.result.ok).toBe(true);
    expect(calls[0]!.headers["x-customer-email"]).toBe("alice@example.com");
    expect(calls[0]!.headers.authorization).toBe("Bearer t");
  });

  it("rejects unknown tools and malformed arguments before any API call", async () => {
    const { ex, calls } = setup();
    expect((await ex.execute(call("issueRefund", { amount: 10 }))).result).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    expect((await ex.execute(call("getOrder", { orderId: "1001", reason: why }))).result).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect((await ex.execute(call("getOrder", undefined))).result).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect((await ex.execute(call("getOrder", { orderId: "SM-1009" }))).refusedBy).toBe("validation"); // reason is required
    expect(calls).toHaveLength(0);
  });

  it("requires getOrder before a mutation on that order", async () => {
    const { ex, calls } = setup();
    const r = await ex.execute(call("updateShippingAddress", { orderId: "SM-1009", address: addr, reason: why }));
    expect(r.refusedBy).toBe("agent_guardrail");
    expect(calls).toHaveLength(0);

    await ex.execute(call("getOrder", { orderId: "SM-1009", reason: why }));
    const ok = await ex.execute(call("updateShippingAddress", { orderId: "SM-1009", address: addr, reason: why }));
    expect(ok.result.ok).toBe(true);
    expect(ok.mutating).toBe(true);
  });

  it("a failed getOrder (someone else's order) does not unlock mutations", async () => {
    const { ex, orders } = setup();
    orders["SM-1003"] = { owner: "chloe@example.com", status: "PROOF_PENDING", canChangeAddress: true };
    const look = await ex.execute(call("getOrder", { orderId: "SM-1003", reason: why }));
    expect(look.result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const r = await ex.execute(call("updateShippingAddress", { orderId: "SM-1003", address: addr, reason: why }));
    expect(r.refusedBy).toBe("agent_guardrail");
  });

  it("surfaces API policy refusals as api_policy", async () => {
    const { ex } = setup();
    await ex.execute(call("getOrder", { orderId: "SM-1001", reason: why }));
    const r = await ex.execute(call("updateShippingAddress", { orderId: "SM-1001", address: addr, reason: why }));
    expect(r.refusedBy).toBe("api_policy");
    expect(r.result).toMatchObject({ ok: false, error: { code: "POLICY_VIOLATION" } });
  });

  it("allows each mutation to succeed only once per ticket", async () => {
    const { ex } = setup();
    await ex.execute(call("getOrder", { orderId: "SM-1014", reason: why }));
    expect((await ex.execute(call("createReorder", { orderId: "SM-1014", reason: why }))).result.ok).toBe(true);
    const again = await ex.execute(call("createReorder", { orderId: "SM-1014", reason: why }));
    expect(again.refusedBy).toBe("agent_guardrail");
  });

  it("uses a deterministic idempotency key so retries cannot double-order", async () => {
    const { ex, calls } = setup();
    await ex.execute(call("getOrder", { orderId: "SM-1014", reason: why }));
    await ex.execute(call("createReorder", { orderId: "SM-1014", items: [{ sku: "DC-3X3", quantity: 400 }], reason: why }));
    const m = calls.find((c) => c.query.includes("createReorder"))!;
    expect(m.variables).toMatchObject({ id: "SM-1014", key: "T-1:SM-1014", items: [{ sku: "DC-3X3", quantity: 400 }] });
  });

  it("blocks all mutations after escalating to a human", async () => {
    const { ex } = setup();
    await ex.execute(call("getOrder", { orderId: "SM-1009", reason: why }));
    const esc = await ex.execute(call("escalateToHuman", { category: "REFUND", reason: "customer wants a refund", summary: "refund" }));
    expect(esc.result.ok).toBe(true);
    expect(ex.hasEscalated).toBe(true);
    const r = await ex.execute(call("updateShippingAddress", { orderId: "SM-1009", address: addr, reason: why }));
    expect(r.refusedBy).toBe("agent_guardrail");
  });

  it("injects the ticket id into escalations and validates the category", async () => {
    const { ex, calls } = setup();
    const bad = await ex.execute(call("escalateToHuman", { category: "VIP", reason: "customer wants a refund", summary: "x" }));
    expect(bad.refusedBy).toBe("validation");
    await ex.execute(call("escalateToHuman", { category: "AMBIGUOUS", reason: "not sure what they need", summary: "unclear" }));
    expect(calls.at(-1)!.variables).toMatchObject({ in: { ticketId: "T-1", category: "AMBIGUOUS" } });
  });

  it("turns a null order into an explicit NOT_FOUND", async () => {
    const { ex } = setup();
    const r = await ex.execute(call("getOrder", { orderId: "SM-9999", reason: why }));
    expect(r.result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
