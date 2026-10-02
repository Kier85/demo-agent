// HTTP front door for the agent (Cloud Run / docker compose).
//
//   GET  /            demo page
//   GET  /healthz     liveness
//   POST /v1/tickets  { customerEmail, message, provider?, ticketId? } -> { outcome, reply, decisionReason, trace }
import "./env.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { createProvider, hasCredentials, PROVIDERS, type ProviderName } from "./providers/index.ts";
import { ShopClient } from "./shop.ts";

const PORT = Number(process.env.PORT ?? 3000);
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "";
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER ?? "anthropic") as ProviderName;
const shop = ShopClient.fromEnv();
const demoPage = readFile(path.join(import.meta.dirname, "demo.html"), "utf8");

const TicketBody = z.object({
  customerEmail: z.email(),
  message: z.string().min(1).max(4000),
  provider: z.enum(PROVIDERS).optional(),
  ticketId: z.string().max(64).optional(),
});

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

function authorised(req: IncomingMessage): boolean {
  if (!AGENT_TOKEN) return true;
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(AGENT_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/") {
      const providers = PROVIDERS.filter(hasCredentials);
      const html = (await demoPage)
        .replace("__PROVIDERS__", JSON.stringify(providers))
        .replace("__DEFAULT__", JSON.stringify(providers.includes(DEFAULT_PROVIDER) ? DEFAULT_PROVIDER : providers[0]))
        .replace("__TOKEN_REQUIRED__", String(!!AGENT_TOKEN));
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/v1/tickets") {
      if (!authorised(req)) return send(res, 401, { error: "unauthorized" });
      const parsed = TicketBody.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: z.prettifyError(parsed.error) });
      const body = parsed.data;
      const name = body.provider ?? DEFAULT_PROVIDER;
      if (!hasCredentials(name)) return send(res, 400, { error: `provider ${name} is not configured` });
      const trace = await runAgent(
        { id: body.ticketId ?? `web-${randomUUID().slice(0, 8)}`, customerEmail: body.customerEmail, message: body.message },
        { provider: createProvider(name), shop },
      );
      return send(res, 200, { outcome: trace.outcome, reply: trace.reply, decisionReason: trace.decisionReason, trace });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: (err as Error).message }));
    send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ severity: "INFO", message: `agent listening on :${PORT}`, providers: PROVIDERS.filter(hasCredentials) }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
