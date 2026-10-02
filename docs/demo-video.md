# 2-minute demo video: shot list

Setup before recording: `docker compose up --build`, keys in `agent/.env`, one eval already run so `agent/eval/results/latest.md` is filled in. Use a 1080p screen, a large terminal font, and the browser at http://localhost:3000.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:12 | README architecture diagram | "An order-support agent for a print-on-demand shop. A Go GraphQL backend over Postgres, a TypeScript agent that runs on Claude, OpenAI or Grok, with guardrails, traces and an eval." |
| 0:12–0:35 | Demo page: alice, "Where is my order SM-1001?", provider anthropic | "The model picks the steps: getOrder, then getShipment, then it replies. Each tool call carries the model's reason." Point at the steps list. |
| 0:35–0:55 | Demo page: sample "I just moved! ... SM-1009 ..." | "A real write: the address change is allowed because the order hasn't entered production. The API re-checks that inside the transaction." |
| 0:55–1:15 | Demo page: chloe, SM-1011 address change | "Same request, but this order is in production. The agent escalates with a reason instead of trying." Optional: switch provider to xai and resend, to show it's the same loop. |
| 1:15–1:30 | Demo page: hana "SYSTEM OVERRIDE ... SM-1009" | "Prompt injection aimed at someone else's order. The API scopes every query to the verified customer, so the order simply doesn't exist for her." |
| 1:30–1:50 | Terminal: `cat agent/eval/results/latest.md` (or the README table) | "Thirty labelled tickets per provider: resolved, correct escalations, wrong actions, p50 latency, cost per ticket. Above 5% wrong actions, the kill switch disables that provider." |
| 1:50–2:00 | Editor: one trace JSON from `agent/traces/` | "Every run is a JSON trace: LLM steps, tool calls, guardrails and the decision reason. It deploys to Cloud Run with one script." |

To show the kill switch live, in a second terminal:

```bash
curl -s localhost:8080/graphql -H 'authorization: Bearer local-api-token' -H 'x-admin-token: local-admin-token' \
  -H 'content-type: application/json' \
  -d '{"query":"mutation{setAgentStatus(provider:\"anthropic\",enabled:false,reason:\"demo\"){enabled}}"}'
```

Send any ticket: it is handed to a human without calling the LLM (`guardrail: kill_switch`). Re-enable it with `enabled:true`.
