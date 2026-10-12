# Saved PayPal (Vault) autonomous purchasing

**Status:** implemented and verified with simulated PayPal responses (unit, PostgreSQL integration, and a browser spec written for the isolated stack). Not verified against PayPal Sandbox. No live-provider claim is made.

## What it does

Before this change an AgentGuard `ALLOW` still sent the buyer to PayPal and then asked them to press **Complete Sandbox payment**. With a saved PayPal method and explicit consent, the server now pays an `ALLOW` proposal buyer-not-present using a PayPal Vault v3 payment token, without a redirect. Every existing boundary stays in place: AI proposes, AgentGuard authorizes, PayPal executes.

## Consent flow (Settings)

1. The **Save PayPal for autonomous purchases** card explains the exact scope: only purchases AgentGuard allows under an active mandate, within that mandate's automatic limit, while automatic permissions are on; removable at any time. The user must tick the consent checkbox; the API also requires `{ consent: true, consentVersion: "2026-10-12" }`.
2. `POST /api/payment-methods/paypal/setup` records the consent (`PAYMENT_METHOD_SETUP_STARTED`), persists a `PayPal-Request-Id` first, then calls `POST /v3/vault/setup-tokens` (`usage_type MERCHANT`, `customer_type CONSUMER`, `usage_pattern IMMEDIATE`, `NO_SHIPPING`, return/cancel `/settings?vault=return|cancel`). The `approve` link is validated against the environment's PayPal buyer hosts on the server and again in the browser (`isSafePayPalApprovalUrl`). A repeat start reuses the same link; an uncertain failure replays the same request id.
3. On return, `POST /api/payment-methods/paypal/complete` ignores the redirect's query string and exchanges the **stored** setup token (`POST /v3/vault/payment-tokens`, stable request id). The payment token id is encrypted with AES-256-GCM (key derived from `TOKEN_ENCRYPTION_KEY`, the owner's user id as additional authenticated data) and a keyed HMAC is stored for webhook matching. The profile becomes `ACTIVE` and `PAYMENT_METHOD_SAVED` is written with only a masked payer email. The token id is never logged, audited or returned.
4. Without a valid 32-byte key, a Vault-capable PayPal client or with platform maintenance/checkout disabled, saving is refused.

## Removal

`POST /api/payment-methods/paypal/remove` moves the profile to `REMOVAL_PENDING` under the user lock (autopay requires `ACTIVE`, so it is never charged again), then calls `DELETE /v3/vault/payment-tokens/{id}`. Only PayPal's success or `404` marks it `REVOKED` (ciphertext cleared, `PAYMENT_METHOD_REVOKED`). If PayPal is unreachable it stays `REMOVAL_PENDING` and is retried on the next removal request or when the owner opens Settings. A verified `VAULT.PAYMENT-TOKEN.DELETED` webhook (PayPal confirms the token is gone with a `404` on re-read) also revokes it. `VAULT.PAYMENT-TOKEN.CREATED` is reconciled idempotently and never activates a method by itself.

## Autonomous execution

`POST /api/proposals/:id/autopay` (owner only, trusted origin, shared per-user financial-mutation rate limit) and the read-only `GET /api/proposals/:id/autopay` preview.

Read-only pre-checks refuse (`NOT_ELIGIBLE` with a reason, no side effects): proposal not `AUTHORIZED`, Channel3/non-demo product, total above the mandate's automatic limit, a human approval exists (`HUMAN_APPROVED` keeps normal checkout), latest decision not `ALLOW`, Vault not configured, no `ACTIVE` saved method, disabled account, maintenance, checkout disabled, platform autonomy off, user autonomy off.

The claim transaction locks `User` first, re-reads the saved method and all switches, then reuses `revalidateAuthorizationInTransaction` (User → Mandate → Proposal locks, fresh Demo Catalog price/version/expiry, spend and reservation). It requires the fresh decision to be exactly `ALLOW`, no human approval and the automatic limit, then creates the payment with `paymentSource = VAULT`, status `CAPTURE_PENDING`, stable order/capture request ids, proposal `PAYMENT_PENDING`, and `AUTONOMOUS_PAYMENT_STARTED`. One payment per proposal is enforced by the existing unique constraint.

Provider call: `POST /v2/checkout/orders` with the same server-owned items/breakdown and `payment_source.paypal.vault_id`, `PayPal-Request-Id` = the payment's stored order request id.

| PayPal result                                                                                                                                                       | MandatePay outcome                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLETED` with one capture                                                                                                                                        | Existing capture validation; payment `COMPLETED`, reservation consumed, `PAYMENT_CAPTURED` + `AUTONOMOUS_PAYMENT_COMPLETED`. **PAID**                   |
| `APPROVED`/`CREATED`                                                                                                                                                | Existing capture path with the stored capture request id. A payer-action refusal returns it to checkout.                                                |
| `PAYER_ACTION_REQUIRED`                                                                                                                                             | Order kept; payment `CREATED`, source back to `CHECKOUT`, payer-action link stored, proposal `PAYPAL_ORDER_CREATED`. **FALLBACK**, nothing charged.     |
| Definitive refusal that only rules out the saved method (`NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`, `INSTRUMENT_DECLINED`, `PAYMENT_SOURCE_*`, `RESOURCE_NOT_FOUND`, …) | Nothing exists at PayPal; order request id rotated, proposal `AUTHORIZED`, normal checkout available. **FALLBACK** (`AUTONOMOUS_PAYMENT_FALLBACK`).     |
| Any other definitive 4xx                                                                                                                                            | Wave 1 failure handling: payment `FAILED`, proposal `FAILED`, reservation `RELEASED`, `AUTONOMOUS_PAYMENT_FAILED`. **FAILED**                           |
| Timeout, 5xx, 409/429, malformed response                                                                                                                           | Payment stays `CAPTURE_PENDING` with its reservation held. **PENDING**. A retry replays the same request id; a verified order/capture webhook binds it. |

Retries never create a second order or capture: concurrent requests serialize on the user lock and share the in-process request, later requests resume the existing payment (replaying the same `PayPal-Request-Id` only while the method is still `ACTIVE`, otherwise only reading provider state). A verified `CHECKOUT.ORDER.COMPLETED`/`PAYMENT.CAPTURE.*` webhook for a Vault order whose create response was lost binds it by PayPal's `reference_id` (payment id), `custom_id` (proposal id) and exact amount, then settles it through the existing reconciler.

## Chat

When the shopping agent's proposal is `AUTHORIZED` with an `ALLOW` decision, the agent route calls the autopay endpoint internally (same cookies and origin) and adds `autopay: { outcome, reason, paymentId, paymentStatus }` and the refreshed proposal to the tool result. The proposal card reads the server preview and shows **Paid automatically with your saved PayPal · View receipt**, a checkout link after a payer-action fallback, or **save PayPal in Settings** when no method exists. Proposals that need approval or are blocked are unchanged.

## Admin

Autopay reads the same `payments.autonomyEnabledGlobally`, `payments.checkoutEnabled` and `platform.maintenanceMode` controls (fail-closed) and the per-user autonomy flag that the admin "disable autonomy" action clears. No new admin UI was added.

## Data model (migration `20261012000300_add_paypal_vault_autopay`)

Additive only: `PaymentProfileStatus` gains `SETUP_PENDING`, `ACTIVE`, `REMOVAL_PENDING`; `PaymentProfile` gains `paypalVaultIdHash` (unique), setup token/request/link/expiry, payment-token request id, consent version/time, masked payer email, activation/removal/revocation timestamps and a safe error code; new enum `PaymentSource { CHECKOUT, VAULT }` and `Payment.paymentSource` (default `CHECKOUT`); eight audit event types (`PAYMENT_METHOD_*`, `AUTONOMOUS_PAYMENT_*`).

## Operator setup

See [Render: Saved PayPal (Vault)](../deployment/RENDER.md#saved-paypal-vault-for-autonomous-purchases) and [environment](../development/environment.md#saved-paypal-vault-encryption-key): enable Vault on the Sandbox REST app, set a 32-byte `TOKEN_ENCRYPTION_KEY`, subscribe the webhook to `VAULT.PAYMENT-TOKEN.CREATED`/`DELETED`.

## Known limits

- An uncertain Vault order whose method is removed before a retry stays `PENDING` (reservation held) until a verified webhook or an operator reconciles it; `worker:reconcile` only revisits payments that already have a PayPal order id.
- Rotating `TOKEN_ENCRYPTION_KEY` makes saved tokens unreadable: autopay falls back to checkout, and removal stays pending until the token is also removed in PayPal.
- One saved PayPal method per user; Vault for cards, recurring and price-watch purchases are not implemented.
