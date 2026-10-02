import type { ShopClient } from "../shop.ts";
import type { ToolCall } from "../providers/types.ts";
import { MUTATING_TOOLS, isToolName, schemas, type ToolArgs, type ToolName } from "./definitions.ts";

/** What the executor hands back to the model (serialised as JSON). */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Who refused a call, for traces and the eval. */
export type RefusedBy = "validation" | "agent_guardrail" | "api_policy" | null;

export interface ExecutedCall {
  name: string;
  args: Record<string, unknown> | undefined;
  reason?: string;
  result: ToolResult;
  refusedBy: RefusedBy;
  mutating: boolean;
  latencyMs: number;
}

const ORDER_FIELDS = `id status createdAt totalCents currency canChangeAddress reorderOf
  shippingAddress { name line1 line2 city region postalCode country }
  items { sku product size quantity unitPriceCents }`;

const API_POLICY_CODES = new Set(["POLICY_VIOLATION", "NOT_FOUND", "INVALID_INPUT", "FORBIDDEN", "UNAUTHENTICATED"]);

/**
 * Executes tool calls for one ticket. Everything here is plain code: the model
 * proposes, this class disposes. Guardrails enforced here, before the API:
 *
 *  1. Arguments must match the tool's zod schema.
 *  2. Identity: the customer email and ticket id are injected, never model-supplied.
 *  3. Look before you act: a mutation needs a successful getOrder for that order
 *     earlier in the same ticket.
 *  4. Budget: each mutating tool may succeed at most once per ticket.
 *  5. Handoff is final: after escalateToHuman no further mutations are allowed.
 *
 * The API then enforces business policy (address changes before production,
 * reorder limits, ownership) inside its own transactions.
 */
export class ToolExecutor {
  private shop: ShopClient;
  private customerEmail: string;
  private ticketId: string;
  private ordersSeen = new Set<string>();
  private mutationsDone = new Set<ToolName>();
  private escalated = false;

  constructor(opts: { shop: ShopClient; customerEmail: string; ticketId: string }) {
    this.shop = opts.shop;
    this.customerEmail = opts.customerEmail;
    this.ticketId = opts.ticketId;
  }

  get hasEscalated(): boolean {
    return this.escalated;
  }

  async execute(call: ToolCall): Promise<ExecutedCall> {
    const started = performance.now();
    const done = (result: ToolResult, refusedBy: RefusedBy, reason?: string): ExecutedCall => ({
      name: call.name,
      args: call.args,
      reason,
      result,
      refusedBy,
      mutating: isToolName(call.name) && MUTATING_TOOLS.has(call.name),
      latencyMs: Math.round(performance.now() - started),
    });
    const refuse = (code: string, message: string, by: RefusedBy, reason?: string) =>
      done({ ok: false, error: { code, message } }, by, reason);

    if (!isToolName(call.name)) return refuse("UNKNOWN_TOOL", `no tool named ${call.name}`, "validation");
    if (call.args === undefined) return refuse("INVALID_ARGS", "arguments were not valid JSON", "validation");

    const parsed = schemas[call.name].safeParse(call.args);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return refuse("INVALID_ARGS", msg, "validation", (call.args as { reason?: string }).reason);
    }
    const args = parsed.data;
    const reason = args.reason;

    if (MUTATING_TOOLS.has(call.name)) {
      const orderId = (args as { orderId: string }).orderId;
      if (this.escalated) {
        return refuse("AGENT_GUARDRAIL", "this ticket was already escalated to a human; no further changes are allowed", "agent_guardrail", reason);
      }
      if (this.mutationsDone.has(call.name)) {
        return refuse("AGENT_GUARDRAIL", `${call.name} already succeeded once for this ticket; a second change needs a human`, "agent_guardrail", reason);
      }
      if (!this.ordersSeen.has(orderId)) {
        return refuse("AGENT_GUARDRAIL", `call getOrder for ${orderId} and check its status before changing it`, "agent_guardrail", reason);
      }
    }

    let result: ToolResult;
    try {
      result = await this.dispatch(call.name, args);
    } catch (err) {
      return refuse("BACKEND_UNAVAILABLE", (err as Error).message, null, reason);
    }

    if (result.ok) {
      if (call.name === "getOrder" && result.data) this.ordersSeen.add((args as ToolArgs<"getOrder">).orderId);
      if (MUTATING_TOOLS.has(call.name)) this.mutationsDone.add(call.name);
      if (call.name === "escalateToHuman") this.escalated = true;
      return done(result, null, reason);
    }
    return done(result, API_POLICY_CODES.has(result.error.code) ? "api_policy" : null, reason);
  }

  private async gql(query: string, variables: Record<string, unknown>, field: string): Promise<ToolResult> {
    const r = await this.shop.query<Record<string, unknown>>(query, variables, { customerEmail: this.customerEmail });
    if (r.errors?.length) {
      const e = r.errors[0]!;
      return { ok: false, error: { code: e.extensions?.code ?? "API_ERROR", message: e.message } };
    }
    return { ok: true, data: r.data?.[field] ?? null };
  }

  private async dispatch(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "getOrder": {
        const { orderId } = args as ToolArgs<"getOrder">;
        const r = await this.gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: orderId }, "order");
        // Null means missing or someone else's order. Say so explicitly so the
        // model doesn't treat "null" as an empty-but-valid order.
        if (r.ok && r.data === null) return { ok: false, error: { code: "NOT_FOUND", message: `no order ${orderId} on this customer's account` } };
        return r;
      }
      case "getShipment": {
        const { orderId } = args as ToolArgs<"getShipment">;
        const r = await this.gql(
          `query($id: ID!) { shipment(orderId: $id) { orderId carrier trackingNumber status shippedAt estimatedDelivery deliveredAt events { at location description } } }`,
          { id: orderId },
          "shipment",
        );
        if (r.ok && r.data === null) return { ok: true, data: { shipped: false, note: `order ${orderId} has no shipment yet (or is not on this account)` } };
        return r;
      }
      case "updateShippingAddress": {
        const { orderId, address } = args as ToolArgs<"updateShippingAddress">;
        return this.gql(
          `mutation($id: ID!, $a: AddressInput!) { updateShippingAddress(orderId: $id, address: $a) { ${ORDER_FIELDS} } }`,
          { id: orderId, a: address },
          "updateShippingAddress",
        );
      }
      case "createReorder": {
        const { orderId, items } = args as ToolArgs<"createReorder">;
        return this.gql(
          `mutation($id: ID!, $items: [ReorderItemInput!], $key: String!) { createReorder(orderId: $id, items: $items, idempotencyKey: $key) { ${ORDER_FIELDS} } }`,
          // Deterministic key: retries of the same ticket can never double-order.
          { id: orderId, items: items ?? null, key: `${this.ticketId}:${orderId}` },
          "createReorder",
        );
      }
      case "escalateToHuman": {
        const a = args as ToolArgs<"escalateToHuman">;
        return this.gql(
          `mutation($in: EscalationInput!) { escalateToHuman(input: $in) { id category reason } }`,
          { in: { ticketId: this.ticketId, orderId: a.orderId ?? null, category: a.category, reason: a.reason, summary: a.summary } },
          "escalateToHuman",
        );
      }
      case "respondToCustomer":
        return { ok: true, data: { delivered: true } };
    }
  }
}
