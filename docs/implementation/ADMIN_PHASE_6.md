# Admin Phase 6 — Payment, refund, and webhook operations

Completed and verified locally on 2026-10-06 after [safe user/domain controls](./ADMIN_PHASE_5.md). All 25 tasks and four exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). Administrators can reconcile PayPal orders/payments, initiate a remaining refund through the existing guarded refund service, refresh pending refund status, retry verified inbox events, and reconcile a uniquely linked payment. PayPal Sandbox remains authoritative: reconcile never captures, refunds reuse stable request keys and `Refund.id` as invoice ID, and webhook retry uses `claimVerifiedForReplay` plus `replayVerified`. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the implemented mutation contracts.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-01–06 | `POST /payments/:id/reconcile` and `POST /orders/:id/reconcile` both call `reconcilePaypalOrder`. Reason, expected status/updatedAt, UUID `requestKey`, and `ADMIN_PAYMENT_RECONCILE_REQUESTED` audit are required. Provider reads update MandatePay; local success is never invented. Same-key retries reuse a completed/pending claim and never recapture.                                                                                                                                                                                         |
| P6-07–15 | **Decision:** admin refund initiation is operationally needed so remaining captured funds can be refunded when the owner cannot act (for example after disable). `POST /payments/:id/refund` calls `refundPayment` with the real owner, `confirmed: true`, `amountMinor` or `null` for remaining, and the admin `requestKey` as the refund idempotency key. Fresh auth, typed payment ID, reviewed remaining amount, and reason are required. Invoice ID stays `Refund.id`. Spending permission is not restored. The UI submits remaining-full only. |
| P6-16–17 | `POST /refunds/:id/refresh` calls `reconcileRefundStatus` for known provider refund IDs. Additive audit value `ADMIN_REFUND_REFRESH_REQUESTED` (migration `20261006000200_add_admin_refund_refresh_audit`). Initiation audits `ADMIN_REFUND_REQUESTED` against the payment ID until a refund row exists.                                                                                                                                                                                                                                             |
| P6-18–24 | `POST /webhooks/:id/retry` claims with `PrismaWebhookInboxStore.claimVerifiedForReplay` and replays through `createPayPalWebhookService().replayVerified`. Eligibility is verified due FAILED or stale PROCESSING, attempts `< 5`. Concurrent claims 409. Stale lease recovery is the same retry, not a separate release. `POST /webhooks/:id/reconcile` requires exactly one linked payment, then `reconcilePaypalOrder` / `reconcileRefundStatus`. Audits: `ADMIN_WEBHOOK_RETRY_REQUESTED`, `ADMIN_WEBHOOK_RECONCILE_REQUESTED`.                   |
| P6-25    | Isolated API integration covers anonymous/non-admin rejection, missing reason, CREATED→APPROVED reconcile, order reconcile, same-key refund replay without a second `refundCapture`, fresh-auth and amount-review rejection, webhook concurrent retry, linked reconcile, and audit visibility. Admin Chromium covers pending-payment reconcile, remaining refund, webhook retry, and those audit actions without webhook secrets.                                                                                                                    |

All four exits are satisfied: the admin can recover operational payment/webhook failures, PayPal remains authoritative, admin retries cannot duplicate captures/refunds, and every financial action is idempotent, reasoned, and audited.

## Verification

- **346 repository unit tests** pass, including refund mutation schema and BFF reconcile allowlist tests.
- **13 environment/server-package boundary tests** pass. Admin source and package.json still exclude server packages.
- **90 isolated PostgreSQL API integration tests** pass (12 files), including the finance case in `apps/api/src/admin.integration.test.ts`.
- **8 isolated database integration tests** pass.
- **Eight admin browser tests** pass against a production Next build, real API and isolated PostgreSQL test database. Existing identity/BFF/session/foundation/operations/controls tests still pass. The finance test follows pending reconcile → remaining refund → webhook retry and asserts those admin audit actions without webhook secrets.
- Affected lint/types, production admin build, source/bundle boundary checks and changed-file formatting pass. Migration `20261006000200_add_admin_refund_refresh_audit` is applied to the local development and isolated test databases.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
pnpm --filter @mandatepay/api test:integration
node node_modules/@playwright/test/cli.js test --config playwright.admin.config.ts
```

Windows executable shims in this workspace are incomplete, so installed CLIs are invoked directly with Node where needed. Principal-owning fixtures must run sequentially against the same dedicated test database. Playwright global teardown posts `/__admin_fixture/cleanup` so a subset run does not leave the singleton principal in place for API integration.

## Remaining boundaries

No real administrator was selected/provisioned, and no hosting or live provider qualification is claimed. Financial fixtures in browser/API tests use an injected simulated PayPal client, not live Sandbox buyer flows. Mutable financial fixtures are cleaned up; immutable PolicyDecision, MandateVersion, MandateRule, ProductSnapshot and audit rows deliberately remain in the isolated test database. Isolated browser tests raise the admin read limiter to **2000**, the mutation limiter to **100**, and the financial limiter to **50**; production remains 120 reads, 20 mutations, and 5 financial/recovery actions per principal per 60s.

Admin cannot capture, force-complete, edit amounts, restore spend after refund, retry unsigned/exhausted webhooks, or reconcile ambiguous/unlinked webhook events. Platform settings remain Phase 7. Reconcile of a payment without a PayPal order ID is not offered.

Root formatting's known unrelated baseline and the pre-existing WebhookInbox schema/index discrepancy remain untouched. The approved customer landing page/artwork and customer payment/refund services are unchanged except that admin now calls those existing services.
