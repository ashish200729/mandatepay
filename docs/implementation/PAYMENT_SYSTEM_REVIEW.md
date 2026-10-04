# Sandbox payment system review

Scope confirmed by the user on 2026-10-04: improve the current PayPal Sandbox system. Live payments and deployment are outside this review. Preserve the deterministic permission boundary, explicit human confirmations, existing design and unrelated local changes.

The review covers proposal/approval ownership, authoritative prices and integer money, spending reservations, order/capture idempotency, provider response validation, signed webhook reconciliation, refunds, recovery, and browser state. Automated provider tests use simulated PayPal; the existing real Sandbox capture/full-refund evidence is tracked separately in PROGRESS.md.

## Corrected findings

| Finding                                                                                   | Consequence                                                          | Required verification                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Capture settlement accepts only UTC timestamps ending in Z                                | A valid offset timestamp can leave a successful capture pending      | Offset capture response and reconciliation tests                                                   |
| Capture recovery reads current product data before settling an existing completed capture | Catalog changes can prevent recording money already captured         | Expired/revoked permission and changed-catalog read-only recovery                                  |
| Status refresh only reads local records                                                   | A missing/delayed webhook leaves known provider outcomes stale       | Authenticated provider status checks that never create orders/captures/refunds                     |
| Receipt does not expose the authorization deadline                                        | An expired approved order offers an unusable payment action          | Deadline display, action expiration and pending recovery browser tests                             |
| Old expired reservations are included indefinitely by the API policy path                 | Abandoned checkouts can block later purchases                        | Release expired unpaid holds while retaining every uncertain capture hold                          |
| Sample records are not excluded consistently from financial paths                         | Seeded activity can affect spending or appear as real orders         | Sample ownership/read/write/spending exclusion tests                                               |
| Capture/order retries do not treat refunded receipts as settled                           | Repeated calls can show errors or attempt to downgrade a later state | Monotonic completion/refund race tests                                                             |
| Non-positive partial refund requests reach the service error path                         | Invalid input can be reported as service unavailable                 | Invalid amount rejects before any provider call                                                    |
| Adapter accepts request IDs beyond PayPal's documented header limit                       | Unsupported values can fail at the provider boundary                 | Bounded ASCII request IDs rejected before network access                                           |
| Refund settlement rejects valid offset timestamps and misses capture links                | A completed Sandbox refund remains submitted                         | Offset timestamps, safe link parsing, authoritative provider reads and signed-event reconciliation |
| Refund/capture uncertainty loses the original request or hides recovery                   | A retry can be confusing or use a changed refund amount              | Stable request keys, frozen pending amounts, explicit status checks and terminal-state controls    |
| Repository refund helpers do not serialize concurrent writes consistently                 | Concurrent requests can conflict or miscalculate settlement          | Parent-first locks, immutable idempotent payloads and concurrent integration tests                 |

The fixes retain explicit human payment/refund confirmation, server-owned product facts, integer USD amounts, signature verification, ownership checks and deterministic AgentGuard decisions. Status checks only read existing provider objects; they do not create orders, capture payments or submit refunds. Existing completed provider outcomes can be recorded after permission expiry, while new financial execution still requires current authorization.

Two existing browser checks also exposed a resize-following issue in chat and an empty Demo Catalog search for a brand alternative such as “Sony or Bose”. Those corrections preserve the existing interface and restrictions. The synthetic shopping fixture now honors early filtering of refurbished products under a NEW-only mandate. Isolated browser account setup uses separate test IPs; a bounded test-only application option accommodates fixture provisioning without changing production authentication limits.

## Completion evidence

`pnpm check` passed: repository lint, TypeScript checks, **313 unit tests**, **11 environment tests** and all production builds. `pnpm test:integration` passed **8 database tests** and **71 API tests** against the isolated test database. The final complete Chromium run passed **37 browser scenarios**, including the mandate/discovery/approval/capture/refund flow and desktop/mobile recovery controls. Repository formatting and whitespace checks passed. The development API's readiness endpoint confirmed the local database/auth service is ready.

The earlier real Sandbox evidence remains one USD 139 guest approval, capture and completed full refund, including signed webhook processing and the actual REFUNDED receipt. This review's automated provider responses are simulated; it did not submit another real Sandbox charge or refund.

Live partial refunds, repeated real webhook delivery, sustained tunnel/recovery operation and deployment qualification remain unverified. No live-payment release claim is made. Changes remain local; no new integration, database migration or infrastructure was introduced.
