import { describe, expect, it } from "vitest";
import { promisesRefund, runAgent, SAFE_ESCALATION_REPLY } from "../src/agent.ts";
import { call, fakeShop, ScriptedProvider } from "./fakes.ts";

const ticket = { id: "T-9", customerEmail: "alice@example.com", message: "Where is SM-1001?" };
const run = (p: ScriptedProvider, shop = fakeShop().shop, extra = {}) => runAgent(ticket, { provider: p, shop, persist: false, ...extra });
const respond = (message: string, outcome = "resolved") => call("respondToCustomer", { message, outcome, reason: "request handled" });

describe("runAgent", () => {
  it("runs the LLM-chosen tools and finishes on respondToCustomer", async () => {
    const p = new ScriptedProvider([
      [call("getOrder", { orderId: "SM-1001", reason: "look it up" })],
      [call("getShipment", { orderId: "SM-1001", reason: "tracking" })],
      [respond("It's in transit with UPS.")],
    ]);
    const t = await run(p);
    expect(t.outcome).toBe("resolved");
    expect(t.reply).toBe("It's in transit with UPS.");
    expect(t.steps.filter((s) => s.kind === "tool").map((s) => s.kind === "tool" && s.name)).toEqual(["getOrder", "getShipment", "respondToCustomer"]);
    expect(t.usage).toEqual({ inputTokens: 3000, outputTokens: 150, llmCalls: 3 });
    expect(t.costUsd).toBeCloseTo((3000 * 2 + 150 * 10) / 1e6); // claude-sonnet-5-5 list price
    // Tool results are fed back to the model in the next turn.
    const second = p.requests[1]!.messages.at(-1)!;
    expect(second.role).toBe("tool");
  });

  it("reports escalated with the escalation reason as the decision", async () => {
    const p = new ScriptedProvider([
      [call("escalateToHuman", { category: "REFUND", orderId: "SM-1001", reason: "customer requests a refund", summary: "refund SM-1001" }),
       respond("A teammate will follow up.")],
    ]);
    const t = await run(p);
    expect(t.outcome).toBe("escalated");
    expect(t.decisionReason).toBe("customer requests a refund");
    expect(t.escalation).toMatchObject({ id: "ESC-1", category: "REFUND", byGuardrail: false });
  });

  it("executes respondToCustomer last even if the model lists it first", async () => {
    const p = new ScriptedProvider([[respond("done"), call("getOrder", { orderId: "SM-1001", reason: "look" })]]);
    const t = await run(p);
    const names = t.steps.flatMap((s) => (s.kind === "tool" ? [s.name] : []));
    expect(names).toEqual(["getOrder", "respondToCustomer"]);
  });

  it("escalates in plain code when the step budget runs out", async () => {
    const p = new ScriptedProvider([]); // loops on getOrder forever
    const t = await run(p, undefined, { maxSteps: 3 });
    expect(t.outcome).toBe("escalated");
    expect(t.escalation?.byGuardrail).toBe(true);
    expect(t.steps.some((s) => s.kind === "guardrail" && s.rule === "step_budget")).toBe(true);
    expect(t.reply).toBe(SAFE_ESCALATION_REPLY);
    expect(t.usage.llmCalls).toBe(3);
  });

  it("escalates in plain code when the provider throws", async () => {
    const t = await run(new ScriptedProvider([new Error("529 overloaded")]));
    expect(t.outcome).toBe("escalated");
    expect(t.steps.some((s) => s.kind === "guardrail" && s.rule === "provider_error")).toBe(true);
  });

  it("overrides a reply that promises a refund without escalation", async () => {
    const p = new ScriptedProvider([[respond("Good news, your refund has been issued!")]]);
    const t = await run(p);
    expect(t.outcome).toBe("escalated");
    expect(t.escalation).toMatchObject({ category: "REFUND", byGuardrail: true });
    expect(t.reply).toBe(SAFE_ESCALATION_REPLY);
  });

  it("sanitises a refund promise even after a proper escalation", async () => {
    const p = new ScriptedProvider([
      [call("escalateToHuman", { category: "REFUND", reason: "customer requests a refund", summary: "refund" }), respond("You will be refunded within 3 days.")],
    ]);
    const t = await run(p);
    expect(t.escalation?.byGuardrail).toBe(false);
    expect(t.reply).toBe(SAFE_ESCALATION_REPLY);
  });

  it("does not call the LLM when the kill switch is off for the provider", async () => {
    const p = new ScriptedProvider([[respond("hi")]]);
    const t = await run(p, fakeShop({ agentEnabled: false }).shop);
    expect(p.requests).toHaveLength(0);
    expect(t.outcome).toBe("escalated");
    expect(t.steps[0]).toMatchObject({ kind: "guardrail", rule: "kill_switch" });
  });

  it("eval mode can bypass the kill switch to measure a disabled provider", async () => {
    const p = new ScriptedProvider([[respond("hi")]]);
    const t = await run(p, fakeShop({ agentEnabled: false }).shop, { ignoreKillSwitch: true });
    expect(t.outcome).toBe("resolved");
  });

  it("accepts a plain-text final answer", async () => {
    const t = await run(new ScriptedProvider(["Your order is on the way."]));
    expect(t.outcome).toBe("resolved");
    expect(t.decisionReason).toMatch(/plain-text/);
  });
});

describe("promisesRefund", () => {
  it.each([
    "Your refund has been issued.",
    "I've processed a full refund for you.",
    "You'll receive a refund in 3-5 days.",
    "A credit was applied to your account.",
  ])("flags %s", (s) => expect(promisesRefund(s)).toBe(true));

  it.each([
    "I've passed your refund request to our team.",
    "Refunds are handled by a person, who will reply soon.",
    "Your order is out for delivery.",
  ])("allows %s", (s) => expect(promisesRefund(s)).toBe(false));
});
