# Commerce API and failure contracts

All app routes use the database session owner. Mutations require the configured trusted origin and strict JSON; client amounts, provider IDs, owners and policy decisions cannot create purchasing authority. Money is integer USD cents (`amount`, `total`, `priceMinor`, ...).

| Route                                                     | Behavior                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST /api/products/search                                 | Owned active mandate; normalized products; explicit Demo Catalog versus Channel3 source                    |
| POST /api/products/compare                                | Fresh lookup of up to three known IDs; validated AI ranking, no authorization                              |
| POST /api/proposals                                       | ID/source/quantity/requestKey only; server calculates immutable USD-cent totals and snapshots              |
| GET /api/proposals and /:id                               | Owned proposal facts and latest policy outcome, including `decision.explanation`                           |
| POST /api/proposals/:id/evaluate                          | Atomic deterministic policy, audit, reservation or pending approval                                        |
| GET /api/approvals                                        | Owned pending approval context                                                                             |
| POST /api/proposals/:id/approve or /reject                | Exact fingerprint/version/deadline; checked revalidation; idempotent decision                              |
| POST /api/mandates/:id/simulate                           | Read-only "what if" AgentGuard verdict for a hypothetical purchase; writes nothing                         |
| GET /api/paypal/status                                    | `configured`, `environment` (`sandbox` or `live`) and `webhookConfigured` only, never credentials          |
| POST /api/paypal/orders                                   | proposalId only; fresh permission/product checks, stable provider request ID; `pending` on unknown outcome |
| POST /api/paypal/orders/:id/capture                       | Owned local payment/order; provider approval and exact amount/currency/reference binding                   |
| POST /api/paypal/orders/:id/reconcile                     | Provider reads only for an owned payment; never creates an order or capture                                |
| GET /api/orders and /:id                                  | Owned server-confirmed receipt and refund history                                                          |
| POST /api/payments/:id/refund                             | Explicit confirmed intent, amountMinor or null for remaining full amount, reason and stable requestKey     |
| POST /api/payments/:id/refund-status                      | Provider reads only for the payment's pending refunds                                                      |
| GET /api/payment-methods/paypal                           | Saved PayPal (Vault) status; the payment token ID never leaves the server                                  |
| POST /api/payment-methods/paypal/setup, /complete         | Explicit versioned consent, PayPal buyer approval, then encrypted token storage                            |
| POST /api/payment-methods/paypal/cancel, /remove          | Abandon a pending setup; delete the token at PayPal and revoke it locally                                  |
| GET and POST /api/proposals/:id/autopay                   | Preview, or pay an AgentGuard ALLOW proposal buyer-not-present with the saved PayPal method                |
| POST /api/webhooks/paypal                                 | Public raw JSON callback; signature verification before durable inbox writes                               |
| GET /api/audit                                            | Owned safe facts; payment lookup reconstructs related financial chain                                      |
| GET /api/dashboard/summary, /transactions, /policy-events | Actual owned records; samples excluded; full aggregates and bounded cursor paging                          |
| POST /api/dashboard/query                                 | Strict read-only model filters; exclusive amount operators preserved; no generated SQL                     |
| POST /api/agent/chat                                      | Bounded tool runner with server-owned handlers; no approval, payment, capture or refund execution tool     |
| POST /api/agent/chat/stream                               | The same chat run streamed as Server-Sent Events (`step`, then one `result` or `error`)                    |

Signed AP2-style mandates and the MCP agent surface are documented separately: see [AP2 mandates](./AP2_MANDATES.md) and [MCP integration](../integrations/MCP.md).

## Request and response details

### PayPal checkout

`GET /api/paypal/status` returns `{ "configured": boolean, "environment": "sandbox" | "live", "webhookConfigured": boolean }`. `environment` follows `PAYPAL_ENV` (default `sandbox`).

`POST /api/paypal/orders` with `{ "proposalId": "..." }` returns `{ payment, approvalUrl, pending }`:

- `200` with `pending: false` and the validated PayPal `approvalUrl` once the order exists (or for an already settled/failed payment, with `approvalUrl: null`).
- `202` with `pending: true` and `approvalUrl: null` when PayPal's create-order outcome is unknown (timeout or 5xx). Retrying the same proposal replays the same `PayPal-Request-Id`; no second order is created.
- `422` `{ "error": "...", "code": "PAYPAL_REQUEST_REJECTED" }` when PayPal definitively refused the order. Nothing was created at PayPal, so the request ID rotates and an explicit retry is a new request.
- `409` `PAYER_APPROVAL_REQUIRED` when the proposal is not authorized to pay; `403` `CHECKOUT_DISABLED` or `MAINTENANCE` from platform controls; `503` `PAYPAL_UNAVAILABLE` or `PAYPAL_RESPONSE_INVALID`.

`POST /api/paypal/orders/:id/capture` (local `paymentId`, empty body) returns `{ payment }` with `200`, or `202` while the capture is held or its outcome is unknown. `POST /api/paypal/orders/:id/reconcile` returns `{ payment, pending }` with the same status convention.

The `payment` object (`GET /api/orders/:id` and the routes above) includes `status` (`CREATED`, `APPROVED`, `CAPTURE_PENDING`, `COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `REVERSED`, `DENIED`, `FAILED`), `amount`, `currency`, `paypalOrderId`, `paypalCaptureId`, `capturedAt`, `failureCode`, `providerStatusReason`, `payerActionUrl` (only while the payer must act), `paymentSource` (`checkout` or `vault`), product and mandate facts, and `refunds[]` (each with `providerInitiated`).

Server-owned `failureCode` values (never provider free text; `:ISSUE` is PayPal's safe issue code when present):

| Code                                                        | Meaning                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `PAYPAL_CAPTURE_REJECTED[:ISSUE]`                           | PayPal definitively refused the capture request; reservation released |
| `PAYPAL_CAPTURE_DECLINED`                                   | PayPal returned a DECLINED capture                                    |
| `PAYPAL_CAPTURE_FAILED`                                     | PayPal returned a FAILED capture                                      |
| `PAYPAL_CAPTURE_DENIED`                                     | Verified `PAYMENT.CAPTURE.DENIED` webhook                             |
| `PAYPAL_ORDER_VOIDED`                                       | PayPal voided the order                                               |
| `PAYPAL_VAULT_ORDER_REJECTED[:ISSUE]`                       | PayPal definitively refused a saved-method (Vault) order              |
| `PAYPAL_REFUND_REJECTED[:ISSUE]` (refund)                   | PayPal refused the refund request; refundable amount restored         |
| `PAYPAL_REFUND_FAILED` / `PAYPAL_REFUND_CANCELLED` (refund) | PayPal reported the refund FAILED or CANCELLED                        |

A payer-side capture refusal (`INSTRUMENT_DECLINED`, `PAYER_ACTION_REQUIRED`, `ORDER_NOT_APPROVED`) is not a failure: the payment returns to `CREATED`/`APPROVED` with `providerStatusReason` and a `payerActionUrl`.

### Saved PayPal (Vault) and autopay

Vault is available only when PayPal is configured and `TOKEN_ENCRYPTION_KEY` is a valid 32-byte key; otherwise `paymentMethod.available` is `false` and setup returns `503 VAULT_UNAVAILABLE`.

- `GET /api/payment-methods/paypal` returns `{ paymentMethod }` with `provider: "paypal"`, `status` (`NONE`, `SETUP_PENDING`, `ACTIVE`, `REMOVAL_PENDING`, `REVOKED`), `available`, masked `payerEmail`, `activatedAt`, `removalRequestedAt`, `revokedAt`, `consentVersion` and `currentConsentVersion`.
- `POST .../setup` requires `{ "consent": true, "consentVersion": "<currentConsentVersion>" }` (otherwise `400 CONSENT_REQUIRED`) and returns `{ paymentMethod, approvalUrl }`; the user approves at PayPal.
- `POST .../complete`, `.../cancel` and `.../remove` take an empty body and return `{ paymentMethod }`; `202` while removal at PayPal is still pending (`REMOVAL_PENDING`).
- Errors: `{ error, code }` with `VAULT_UNAVAILABLE` 503, `SETUP_NOT_FOUND`, `SETUP_EXPIRED`, `SETUP_NOT_APPROVED`, `REMOVAL_PENDING` 409, `PAYPAL_REQUEST_REJECTED` 422, `PAYPAL_OUTCOME_UNKNOWN`/`PAYPAL_RESPONSE_INVALID` 503. Method changes have their own small per-user rate limit (429 with `retry-after`).

`GET /api/proposals/:id/autopay` is read-only and returns `{ autopay: { eligible, reason, paymentMethodStatus, payment } }`, where `payment` is `{ id, status, paymentSource }` or `null`.

`POST /api/proposals/:id/autopay` (empty body) returns `{ autopay: { outcome, reason, payment }, proposal, decision }`, `202` when `outcome` is `PENDING`:

| outcome        | Meaning and typical `reason`                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAID`         | Captured with the saved method                                                                                                                                                                                                                                                                                                        |
| `PENDING`      | Outcome unknown (`PAYPAL_OUTCOME_UNKNOWN`) or saved method removed after the claim (`SAVED_METHOD_REMOVED`); the reservation stays held                                                                                                                                                                                               |
| `FALLBACK`     | Nothing charged; the payment returned to the normal buyer-approval checkout (for example `PAYER_ACTION_REQUIRED`, `INSTRUMENT_DECLINED`, `VAULT_TOKEN_UNREADABLE`)                                                                                                                                                                    |
| `NOT_ELIGIBLE` | Nothing created: `PROPOSAL_NOT_AUTHORIZED`, `PRODUCT_NOT_ELIGIBLE`, `ABOVE_AUTOMATIC_LIMIT`, `HUMAN_APPROVED`, `REQUIRES_APPROVAL`, `BLOCKED`, `VAULT_UNAVAILABLE`, `NO_SAVED_PAYMENT_METHOD`, `ACCOUNT_DISABLED`, `MAINTENANCE`, `CHECKOUT_DISABLED`, `PLATFORM_AUTONOMY_OFF`, `AUTONOMY_OFF`, `PRODUCT_CHANGED`, `CHECKOUT_STARTED` |
| `FAILED`       | `PAYPAL_VAULT_ORDER_REJECTED[:ISSUE]` and other failure codes above; reservation released                                                                                                                                                                                                                                             |

Autopay runs only for Demo Catalog proposals that AgentGuard re-evaluates as ALLOW within the automatic limit, inside the same locked claim, while the user's autonomy, platform autonomy and checkout are on.

### Decision explanation

Every `decision` returned with a proposal (and by the simulator) carries a deterministic, read-only `explanation` derived from the stored verdict and snapshots; it never changes the decision:

```json
{
  "decision": "REQUIRE_APPROVAL",
  "headline": "...",
  "summary": "...",
  "approvalCanOverride": true,
  "checks": [
    {
      "rule": "automatic_limit",
      "label": "...",
      "status": "approval",
      "limit": "$150",
      "actual": "$169",
      "message": "..."
    }
  ]
}
```

`status` is `pass`, `approval` or `block`; `approvalCanOverride` is `false` for BLOCK. `rule` is one of `mandate`, `policy_input`, `proposal_integrity`, `product_data`, `product_content`, `currency`, `brand`, `category`, `condition`, `merchant`, `quantity`, `transaction_limit`, `daily_limit`, `weekly_limit`, `monthly_limit`, `spend_context`, `autonomy`, `automatic_limit`, `new_merchant`, `other`. `explanation` is `null` only when a historical record cannot be explained.

### Policy simulator

`POST /api/mandates/:id/simulate` takes `{ price, quantity?, condition, brand?, category?, merchant, shipping?, tax?, asNewMerchant? }` (cents; quantity 1-100) and returns `{ simulated: true, decision, reasonCodes, explanation, mandate: { id, version, status }, facts: { subtotal, total, currency, isNewMerchant, newMerchantSource } }`. It evaluates the mandate's active version with the real AgentGuard engine, current spend and holds, in a READ ONLY transaction. Errors: `{ error, code }` with `INVALID_REQUEST` 400, `ORIGIN_NOT_TRUSTED` 403, `NOT_FOUND` 404, `INVALID_STATE` 409, `RATE_LIMITED` 429 (60 per user per minute), `SIMULATOR_UNAVAILABLE` 503.

### Shopping agent and streaming

`POST /api/agent/chat` takes `{ message, mandateId?, requestKey, productContext? }` and returns `{ message, explanation, proposals, refundDraft, steps, excludedProducts, productContext }`. `excludedProducts` (at most 8) lists retrieved products the mandate excludes, each with the normal product fields plus plain-language `reasons[]` and `promptInjection: true` when the listing's own text tried to instruct AI agents; they are never purchasable through the chat. Product text is content-screened: instruction-like seller text is never passed to the model, and a proposal for such a product receives `PRODUCT_CONTENT_*` reason codes from AgentGuard. Proposal product snapshots keep a bounded (2,000 character) seller `description`, so screening works from the snapshot alone.

`POST /api/agent/chat/stream` accepts the same body and checks. Failures before the run starts keep their ordinary JSON status responses (403, 401, 429, 400). Otherwise it answers `200 text/event-stream`:

```text
: stream-open

event: step
data: {"id":"catalog","label":"Searching the catalog","status":"running"}

event: step
data: {"id":"outcome","label":"Proposal ready — needs your approval","status":"completed"}

event: result
data: { ...exactly the POST /api/agent/chat JSON body... }
```

`step` data is `{ id, label, status }` with server-templated labels (no model or product text) and `status` `running`, `completed`, `blocked` or `failed`; the last step has `id: "outcome"`. The stream ends with one `result` or one `error` event whose data is `{ status, error, code? }` (for example `SHOPPING_TIMEOUT`, `SHOPPING_AI_UNAVAILABLE`). `: keep-alive` comments arrive every 15 seconds. A client disconnect stops new tools from starting.

### PayPal webhooks

`POST /api/webhooks/paypal` verifies the signature before any inbox write and answers `200 {"status":"processed"|"ignored"}`, `202 {"status":"pending"}`, or 400/401/413/415/503. Every handled event is re-fetched from PayPal before any state change:

| Event                                                        | Effect                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKOUT.ORDER.APPROVED`                                    | Marks the bound order approved                                                                                                      |
| `CHECKOUT.ORDER.COMPLETED`                                   | Settles from the order's own capture; binds an unbound Vault payment whose order names its payment, proposal and amount             |
| `PAYMENT.CAPTURE.COMPLETED`                                  | Records the capture and consumes the reservation                                                                                    |
| `PAYMENT.CAPTURE.PENDING`                                    | Records a held capture (`CAPTURE_PENDING` with the PayPal reason); the reservation stays held                                       |
| `PAYMENT.CAPTURE.DENIED`                                     | Fails the payment (`PAYPAL_CAPTURE_DENIED`) and releases the reservation                                                            |
| `PAYMENT.CAPTURE.REFUNDED`                                   | Completes a MandatePay refund, or records a provider-initiated refund (made in PayPal) once and within the captured amount          |
| `PAYMENT.CAPTURE.REVERSED`                                   | Marks a captured payment `REVERSED` (chargeback/reversal)                                                                           |
| `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED` | Matched by the token's keyed hash: CREATED is acknowledged; DELETED revokes the saved method once PayPal confirms the token is gone |

### Workers

Both workers are one-shot processes (scheduled as Render cron jobs) that write a heartbeat shown in admin System health.

- `pnpm --filter @mandatepay/api worker:webhooks` replays verified inbox events that are pending or failed, with leases, exponential backoff and attempt ceilings. It never processes unverified payloads.
- `pnpm --filter @mandatepay/api worker:reconcile` (`PAYMENT_RECONCILE_STALE_MINUTES`, default 10; `PAYMENT_RECONCILE_BATCH_SIZE`, default 50):
  1. reconciles stale `CAPTURE_PENDING` payments that have a PayPal order using provider reads only;
  2. replays the same idempotent create-order request (same `PayPal-Request-Id`) for stale Vault payments whose create-order outcome was unknown and which therefore have no order ID. It does so only while the saved method is `ACTIVE`, the account, maintenance, checkout, platform-autonomy and user-autonomy switches allow it, the mandate is `ACTIVE`, `TOKEN_ENCRYPTION_KEY` is set and the claim is under 3 hours old (PayPal keeps request IDs for a limited time). Otherwise it calls nothing and **keeps the payment pending with its reservation**, because the first request may already have charged the buyer. Payments still unbound after 30 minutes appear as the reconcile worker's backlog in System health for an operator; a verified webhook can still bind them;
  3. releases expired holds of unpaid proposals, keeping every hold a capture may still consume.

## Financial accounting

Money uses safe integer USD cents and PostgreSQL bigint. Weeks start Monday in UTC. Financial operations serialize user, mandate, proposal and payment state consistently. Pending reservations count against every relevant aggregate limit; revalidation excludes the current proposal's own reservation. Confirmed gross capture amounts continue to count after refunds, preventing budget recycling.

An order can require PayPal payer approval even when AgentGuard returns ALLOW. Autonomous (buyer-not-present) payment requires the user's explicit saved-PayPal consent and is limited to ALLOW decisions within the automatic limit; every other case keeps the buyer-approval checkout.

Payment/refund operations persist logical request IDs before network calls and reuse them on retries. Unknown outcomes keep reservations/refundable amounts held. Provider lookup reconciles known completion before another attempt; a browser return URL is never proof of payment. Capture timestamps come from verified provider resources.

Refunds remain available for owned captured purchases even after the purchase mandate expires or is revoked. Concurrent pending/completed refunds count against remaining captured funds. A full refund means the remaining refundable amount, not a second refund of the original total. Invoice and provider IDs bind the operation precisely. Provider-initiated refunds count against the same remainder.

## Failure cases

- Anonymous or another owner's data: 401/404.
- Untrusted mutation origin: 403.
- Unknown fields, unsupported currency, unsafe money or malformed dates: 400.
- Stale mandate/version/price, expired approval or invalid state: 409; no provider execution.
- Hard policy violation: BLOCK before global/autonomous approval reasons.
- Provider outage/unknown mutation outcome: unavailable or 202 pending; no fabricated completion or premature release.
- Definitive PayPal refusal of a new order: 422 `PAYPAL_REQUEST_REJECTED`; nothing was created and the reservation keeps its normal expiry.
- Duplicate order/capture/refund requests: original logical operation, stable keys, no second charge/refund.
- Missing/invalid webhook signature: rejected before inbox writes. Missing webhook configuration: 503.
- Duplicate processed webhook: acknowledged without a second financial/audit transition. Processing leases and authoritative bindings protect concurrent handling.
- Unknown/out-of-order provider state: pending/ignored according to authoritative facts; later denial never downgrades confirmed capture.

## Evidence boundary

PostgreSQL and browser tests exercise actual app state transitions using isolated simulated providers. Live evidence currently covers Sarvam parsing/ranking and Sandbox OAuth only. Real Sandbox buyer approval, captures, Vault setup and buyer-not-present payment, refunds and registered webhook delivery remain separate acceptance gates; no real funds move in this implementation.
