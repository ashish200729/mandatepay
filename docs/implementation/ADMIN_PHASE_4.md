# Admin Phase 4 — Read-only operations data

Completed and verified locally on 2026-10-06 after [UI foundation](./ADMIN_PHASE_3.md). All 32 tasks and four exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). The main administrator can inspect the MVP chain `user → mandate → proposal → approval → order → payment → refund` with bidirectional cross-links, bounded pagination/filters and safe CSV exports. Provider payloads, original prompts, session tokens and credential material stay off these APIs and pages. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the implemented read contracts.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-01    | `AdminOperationsRepository.overview` returns named metrics with `available`/`unavailable` envelopes. Phase 5/7/8 fields stay null with reasons, never zero.                                                                                                                                         |
| P4-02–09 | Cross-owner list/detail queries for users, mandates (plus versions), proposals (plus decisions/reservation), approvals, orders, payments, refunds and webhooks. Orders are payments with a PayPal order ID (`id = Payment.id`). Webhook DTOs expose derived lease/stale/retry/exhausted codes only. |
| P4-10    | Owner, mandate, proposal, approval, payment, refund and webhook identifiers are encoded local links in both directions where the record exists.                                                                                                                                                     |
| P4-11–12 | HMAC filter-bound opaque cursors, list limits 1–100 (default 50), half-open UTC dates ≤366 days, closed enums/sorts and sample exclusion by default.                                                                                                                                                |
| P4-13    | Allowlisted CSV columns, formula neutralization, 1000-row cap, truncation notice and 2 exports/principal/60s. Sessions, payloads and prompts are omitted.                                                                                                                                           |
| P4-14–32 | Overview dashboard, collection + detail pages for users through webhooks, and admin audit list/detail using the Phase 3 table/filter shell. Session remains at `/session`.                                                                                                                          |

All four exits are satisfied: the main admin can inspect the complete MVP flow, cross-links work in both directions where useful, lists are paginated and filterable, and sensitive provider/auth material is not exposed. This phase enables no operational mutations.

## Verification

- **344 repository unit tests** pass, including operations DTO/CSV/filter and BFF allowlist tests.
- **13 environment/server-package boundary tests** pass. Admin source and package.json still exclude server packages.
- **88 isolated PostgreSQL API integration tests** pass (12 files), including the operations chain, sample exclusion, reservation-null 200, webhook redaction, pagination and CSV rate-limiting.
- **Six admin browser tests** pass against a production Next build, real API and isolated PostgreSQL test database. Existing identity/BFF/session/foundation tests still pass. The operations test follows user → mandate → proposal → approval → payment → refund and asserts webhook/prompt secrets never render.
- Affected lint/types, production admin build, source/bundle boundary checks and changed-file formatting pass. No schema migration or new dependency is required.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
pnpm --filter @mandatepay/api test:integration
pnpm test:e2e:admin
```

Windows executable shims in this workspace are incomplete, so installed CLIs are invoked directly with Node where needed. Principal-owning fixtures must run sequentially against the same dedicated test database.

## Remaining boundaries

No real administrator was selected/provisioned, and no hosting or live provider qualification is claimed. Mutable financial fixtures are cleaned up; immutable synthetic PolicyDecision, MandateVersion, MandateRule, ProductSnapshot and audit rows deliberately remain in the isolated test database. Proposal decision filters over-fetch then post-filter, so that pagination is approximate. Checkout eligibility is a recorded demo snapshot, not execution authority. Unavailable Phase 5/7/8 metrics stay unavailable until those models exist. Column cell renderers stay in a client module so list pages do not pass functions across the React Server Component boundary. Isolated browser tests raise the admin read limiter to 500; production remains 120 reads per principal per 60s.

Phases 5–10 remain planned. Root formatting's known unrelated baseline and the pre-existing WebhookInbox schema/index discrepancy remain untouched. The approved customer landing page/artwork and financial services are unchanged.
