# AP2-shaped mandate credentials

MandatePay records each user permission as a **signed, verifiable credential** shaped after the
[Agent Payments Protocol (AP2)](https://ap2-protocol.org/ap2/specification/) v0.2 mandate model. A
credential is a compact JWS that anyone can check against MandatePay's public keys to confirm that
MandatePay issued it for exactly the limits or cart it contains.

> **Status and honesty.** These are _AP2-shaped mandate credentials (v0.2 field names)_. MandatePay
> is not AP2-certified, the credentials are not accepted by any payment network, and AP2 itself is
> still evolving. AgentGuard (deterministic policy) remains the authority that allows or blocks a
> purchase; the credentials make that authority portable and auditable, and they add a cart-binding
> check before PayPal is called.

## What is signed, and when

| Credential (kind)                       | AP2 `vct`                 | Issued when                                                                      |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Open payment mandate (`OPEN_PAYMENT`)   | `mandate.payment.open.1`  | The user activates or resumes a mandate, or saves a new version while active.    |
| Open checkout mandate (`OPEN_CHECKOUT`) | `mandate.checkout.open.1` | Same as above. One of each per immutable mandate version.                        |
| Closed checkout (`CLOSED_CHECKOUT`)     | `mandate.checkout.1`      | A proposal becomes `AUTHORIZED` (AgentGuard `ALLOW` or explicit human approval). |
| Closed payment (`CLOSED_PAYMENT`)       | `mandate.payment.1`       | Same as above. One of each per proposal.                                         |

Issuance runs **after** the activation/authorization transaction commits and never fails or rolls
it back. If signing fails it is logged and retried lazily: `GET /api/mandates/:id/credentials`
issues missing open credentials for an `ACTIVE` mandate, and payment enforcement makes one issuance
attempt for a missing cart mandate. Draft mandates and proposals that were never authorized are
never signed. Credentials are stored append-only in `MandateCredential` (a database trigger rejects
`UPDATE`/`DELETE`, like the other history tables) with an audit event
`MANDATE_CREDENTIAL_ISSUED`.

## Token format

- Header: `{"alg":"ES256","typ":"mandatepay+ap2-mandate+jwt","kid":"<RFC 7638 thumbprint>"}`.
- Registered claims: `iss` (the API's public URL, `API_URL`), `sub` (opaque
  `base64url(sha256("mandatepay-subject:v1:" + userId))` — never an email or name), `iat`, `nbf`,
  `exp`, `jti`.
- `vct` and AP2 fields as below; MandatePay context in a `mandatepay` object
  (`profile: "mandatepay.ap2-shaped.v0.2"`, `kind`, `mandate_id`, `mandate_version_id`,
  `mandate_version`, plus `proposal_id` on closed credentials and the digests of the open
  credentials as `open_mandate_digests` when present).
- Money is always integer minor units with an explicit currency.
- Open credentials: `nbf`/`exp` are the mandate version's `startsAt`/`expiresAt`. Closed
  credentials: `nbf` is the issue time and `exp` the mandate version's expiry.
- `cnf` is **omitted**: there is no agent key binding yet (see limitations).

## Rule mapping

| MandatePay rule                 | Credential field                                                                                                                       | Standard             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Maximum per transaction         | `payment.amount_range` `{currency, min: 0, max}`                                                                                       | AP2 v0.2             |
| Validity window                 | `payment.execution_date` `{not_before, not_after}` and `nbf`/`exp`                                                                     | AP2 v0.2             |
| Allowed merchants               | `payment.allowed_payees` and `checkout.allowed_merchants` `{allowed:[{id,name}]}`                                                      | AP2 v0.2             |
| Blocked merchants               | `mandatepay.blocked_payees` / `mandatepay.blocked_merchants` `{blocked}`                                                               | MandatePay extension |
| Daily / weekly / monthly limits | `mandatepay.window_budget` `{window, timezone: "UTC", currency, max}`                                                                  | MandatePay extension |
| Automatic spending limit        | `mandatepay.approval_threshold` `{currency, max_autonomous}`                                                                           | MandatePay extension |
| New merchant needs approval     | `mandatepay.new_merchant_requires_approval` `{required}`                                                                               | MandatePay extension |
| Product intent                  | `mandatepay.product_intent` `{description}`                                                                                            | MandatePay extension |
| Quantity limit                  | `mandatepay.max_quantity` `{max}`                                                                                                      | MandatePay extension |
| Allowed / blocked categories    | `mandatepay.category_allowlist` / `mandatepay.category_blocklist`                                                                      | MandatePay extension |
| Allowed / blocked brands        | `mandatepay.brand_allowlist` / `mandatepay.brand_blocklist`                                                                            | MandatePay extension |
| Allowed conditions              | `mandatepay.condition_allowlist` `{allowed}`                                                                                           | MandatePay extension |
| Authorized cart                 | closed checkout `checkout_hash` + `mandatepay_checkout` (the cart)                                                                     | AP2 v0.2 (adapted)   |
| Authorized amount and payee     | closed payment `transaction_id` (= checkout hash), `payee`, `payment_amount {amount, currency}`, `payment_instrument {type: "paypal"}` | AP2 v0.2             |

Notes on the custom types:

- An empty allowlist means "any" in MandatePay, so empty lists are **omitted** rather than signed as
  "nothing allowed". The checkout open mandate always carries the product intent, quantity and
  conditions.
- AP2 v0.2's `payment.budget` pairs with `payment.agent_recurrence` to express one cumulative budget;
  it does not express calendar-window caps, so MandatePay uses `mandatepay.window_budget`.
- AP2's `checkout.line_items` requires an enumerated list of acceptable items. A MandatePay mandate
  is a product _intent_ that is checked by AgentGuard, so it is expressed as
  `mandatepay.product_intent` and the category/brand/condition lists instead.
- Unknown `mandatepay.*` types must be treated as additional restrictions by any verifier.

## Checkout hash

`checkout_hash = base64url(sha256(canonicalJSON(cart)))`, where canonical JSON sorts object keys,
has no whitespace, and `cart` is built only from authoritative server records:

```json
{
  "proposal_id": "…",
  "mandate_version_id": "…",
  "product_external_id": "…",
  "source": "demo",
  "merchant": "…",
  "title": "…",
  "condition": "NEW",
  "quantity": 1,
  "unit_price": 13900,
  "shipping": 0,
  "tax": 0,
  "total": 13900,
  "currency": "USD"
}
```

AP2 hashes a merchant-signed `checkout_jwt`. MandatePay's demo merchants do not sign carts, so the
closed checkout credential discloses the canonical cart itself (`mandatepay_checkout`) and hashes
that; `checkout_jwt` is omitted. The closed payment credential's `transaction_id` is the same hash.

## Enforcement before PayPal

Immediately before a PayPal order is created (buyer-approved checkout, `createPaypalOrder` /
`createProviderOrder`) and before a saved-PayPal autopay order (`autopayProposal`), the API:

1. loads both closed credentials for the proposal (one lazy issuance attempt if they are missing);
2. verifies their signatures with the current and previous **public** keys, `typ`, `alg` and `iss`
   (validity windows are left to AgentGuard revalidation, which runs in the same request);
3. recomputes the checkout hash from the stored proposal and product snapshot and compares it with
   the signed `checkout_hash` and `transaction_id`, checks the proposal/version/subject binding, and
   checks that the signed `payment_amount` equals the proposal total and the amount sent to PayPal.

Any mismatch refuses the request with HTTP 409 `CART_MANDATE_MISMATCH`, records an audit event
`CART_MANDATE_MISMATCH` (reason, expected and signed hash), and PayPal is not called. This is
defense in depth against cart tampering after authorization — for example a hidden line item or a
swapped product added between approval and checkout, the hidden-line-item pattern raised in Unit 42's
research on agent payments. It does not replace AgentGuard's own revalidation.

## Endpoints

| Endpoint                             | Auth                  | Purpose                                                                                                                         |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/jwks.json`         | Public                | Current and previous public keys (`ES256`, `use: sig`); cacheable for 5 minutes.                                                |
| `GET /api/credentials/jwks`          | Public                | Same JWKS, reachable through the web BFF on the app origin.                                                                     |
| `POST /api/credentials/verify`       | Public, 30/min per IP | Body `{"credential":"<JWS>"}` or the raw JWS. Returns `{valid, kid, kind, reason, claims}`. Public keys only; no database read. |
| `GET /api/mandates/:id/credentials`  | Owner session         | Open credentials for the active version, with a server-side `verified` result per credential.                                   |
| `GET /api/proposals/:id/credentials` | Owner session         | Closed credentials and `hashVerified` (signature valid and hash equals the recomputed cart).                                    |

Verification reasons: `MALFORMED`, `UNSUPPORTED_ALGORITHM`, `WRONG_TYPE`, `UNKNOWN_KEY`,
`SIGNATURE_INVALID`, `WRONG_ISSUER`, `EXPIRED`, `NOT_YET_VALID`, `UNKNOWN_MANDATE_TYPE`,
`CHECKOUT_HASH_MISMATCH`.

The web app shows a **Verifiable mandate** panel on mandate detail (verified badge, `kid`, validity,
the constraint table, copy/download, JWKS link) and a **Cart mandate · hash verified ✓** line with
the hash prefix on proposal detail and the order receipt.

## Key management

- `MANDATE_SIGNING_KEY`: EC P-256 private JWK as one JSON line. Required in production (the API
  refuses to boot without it). Development and test generate a temporary per-process key with a
  one-time warning; credentials signed before a restart then stop verifying.
- Generate: `pnpm --silent --filter @mandatepay/api mandate:keygen` (private JWK on stdout; `kid`
  and public JWK on stderr). Store it only in an ignored `.env` or the deployment secret store.
- `kid` is the RFC 7638 SHA-256 JWK thumbprint of the public key.
- Rotation: set the new private key, and put the old **public** JWK into
  `MANDATE_SIGNING_PREVIOUS_JWKS` (`{"keys":[…]}` or an array). Previous keys verify only; new
  credentials are always signed with the current key. A credential whose key is in neither variable
  stops verifying. Private keys are rejected in the previous set.

## Limitations

- **Server-signed, not user-signed.** AP2 expects the user's own device key (for example a passkey)
  to sign open mandates. MandatePay signs with its server key on the user's explicit, authenticated
  activation or approval. The credential proves what MandatePay recorded and enforces, not a
  user-held signature.
- **No agent key binding.** `cnf` is omitted, so a credential is not bound to a particular agent's
  key. Agent access is governed separately by MandatePay sessions and agent tokens.
- **No revocation list.** Pausing, revoking or expiring a mandate is enforced by AgentGuard and shown
  in the UI, but a previously issued credential still verifies cryptographically until its `exp`.
- **No selective disclosure.** Credentials are plain JWS, not SD-JWT, and are not chained with `~`
  as in AP2's examples; the closed credentials reference the open ones by digest instead.
- **Lazy recovery signs current facts.** If after-commit issuance failed, the lazy issuance before
  payment signs the cart as currently stored. Tamper protection is strongest when issuance at
  authorization succeeded (the normal path).
- **Not certified.** Field names follow the AP2 v0.2 pages; MandatePay has not been tested against
  any AP2 network participant.
