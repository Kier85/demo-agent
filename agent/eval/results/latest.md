| Provider | Model | Correct | Resolved | Correct escalations | Missed esc. | Unneeded esc. | Wrong actions | Blocked by guardrails | p50 latency | p95 latency | Cost / ticket | Kill switch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mock | `mock` | 27/30 (90%) | 13/15 (87%) | 13/15 (87%) | 2 | 0 | 0 (0.0%) | 4 | 0.0s | 0.0s | $0.0000 | ok |

Incorrect runs:

- mock T07 (where_is_my_order): outcome resolved, wanted escalated
- mock T10 (address_change): missing updateShippingAddress
- mock T12 (address_change): outcome resolved, wanted escalated

Kill-switch threshold: wrong-action rate > 5.0% of tickets.