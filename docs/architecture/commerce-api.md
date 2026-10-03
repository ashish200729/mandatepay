# Commerce API and failure contracts

All app routes use the database session owner. Mutations require the configured trusted origin and strict JSON; client amounts, provider IDs, owners and policy decisions cannot create purchasing authority.

| Route                                                     | Behavior                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST /api/products/search                                 | Owned active mandate; normalized products; explicit Demo Catalog versus Channel3 source                |
| POST /api/products/compare                                | Fresh lookup of up to three known IDs; validated AI ranking, no authorization                          |
| POST /api/proposals                                       | ID/source/quantity/requestKey only; server calculates immutable USD-cent totals and snapshots          |
| GET /api/proposals and /:id                               | Owned proposal facts and latest policy outcome                                                         |
| POST /api/proposals/:id/evaluate                          | Atomic deterministic policy, audit, reservation or pending approval                                    |
| GET /api/approvals                                        | Owned pending approval context                                                                         |
| POST /api/proposals/:id/approve or /reject                | Exact fingerprint/version/deadline; checked revalidation; idempotent decision                          |
| GET /api/paypal/status                                    | Configuration booleans only, never credentials                                                         |
| POST /api/paypal/orders                                   | proposalId only; fresh permission/product checks, stable provider request ID                           |
| POST /api/paypal/orders/:id/capture                       | Owned local payment/order; provider approval and exact amount/currency/reference binding               |
| GET /api/orders and /:id                                  | Owned server-confirmed receipt and refund history                                                      |
| POST /api/payments/:id/refund                             | Explicit confirmed intent, amountMinor or null for remaining full amount, reason and stable requestKey |
| POST /api/webhooks/paypal                                 | Public raw JSON callback; signature verification before durable inbox writes                           |
| GET /api/audit                                            | Owned safe facts; payment lookup reconstructs related financial chain                                  |
| GET /api/dashboard/summary, /transactions, /policy-events | Actual owned records; samples excluded; full aggregates and bounded cursor paging                      |
| POST /api/dashboard/query                                 | Strict read-only model filters; exclusive amount operators preserved; no generated SQL                 |
| POST /api/agent/chat                                      | Bounded tool runner with server-owned handlers; no approval, payment, capture or refund execution tool |

## Financial accounting

Money uses safe integer USD cents and PostgreSQL bigint. Weeks start Monday in UTC. Financial operations serialize user, mandate, proposal and payment state consistently. Pending reservations count against every relevant aggregate limit; revalidation excludes the current proposal's own reservation. Confirmed gross capture amounts continue to count after refunds, preventing budget recycling.

An order can require PayPal payer approval even when AgentGuard returns ALLOW. Saving a wallet and fully autonomous provider execution are separate, unimplemented stretch capabilities.

Payment/refund operations persist logical request IDs before network calls and reuse them on retries. Unknown outcomes keep reservations/refundable amounts held. Provider lookup reconciles known completion before another attempt; a browser return URL is never proof of payment. Capture timestamps come from verified provider resources.

Refunds remain available for owned captured purchases even after the purchase mandate expires or is revoked. Concurrent pending/completed refunds count against remaining captured funds. A full refund means the remaining refundable amount, not a second refund of the original total. Invoice and provider IDs bind the operation precisely.

## Failure cases

- Anonymous or another owner's data: 401/404.
- Untrusted mutation origin: 403.
- Unknown fields, unsupported currency, unsafe money or malformed dates: 400.
- Stale mandate/version/price, expired approval or invalid state: 409; no provider execution.
- Hard policy violation: BLOCK before global/autonomous approval reasons.
- Provider outage/unknown mutation outcome: unavailable or 202 pending; no fabricated completion or premature release.
- Duplicate order/capture/refund requests: original logical operation, stable keys, no second charge/refund.
- Missing/invalid webhook signature: rejected before inbox writes. Missing webhook configuration: 503.
- Duplicate processed webhook: acknowledged without a second financial/audit transition. Processing leases and authoritative bindings protect concurrent handling.
- Unknown/out-of-order provider state: pending/ignored according to authoritative facts; later denial never downgrades confirmed capture.

The verified-pending inbox recovery worker is still Phase 13 work. Current public pending responses can acknowledge delivery; a durable background retry must be completed before production qualification.

## Evidence boundary

PostgreSQL and browser tests exercise actual app state transitions using isolated simulated providers. Live evidence currently covers Sarvam parsing/ranking and Sandbox OAuth only. Real Sandbox buyer approval, captures, refunds and registered webhook delivery remain separate acceptance gates; no real funds move in this implementation.
