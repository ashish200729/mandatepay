# Phase progress and handoff

Checkpoint: 2026-10-03. The user requested that the current implementation batch be finished, documented and stopped. No new Phase 13 work should start until the user resumes it.

## Current implementation

The project is TypeScript/Node only. The approved landing page, shared warm theme, fonts and artwork are preserved. Implemented application surfaces include signup/signin, mandates, discovery/comparison, approvals, Sandbox checkout, order receipts, full/partial refunds, audit timeline and AG Grid Community Control Center.

The API wires the completed mandate, catalog, proposal, payment, refund, verified-webhook, analytics and limited shopping-agent routes. The tool-calling shopping API is implemented; its full conversational frontend experience and live tool-loop qualification remain follow-up work.

## Phase ledger

| Phase | Current state                                                                           | Qualification boundary                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | pnpm/Turbo, tests, native PostgreSQL, MIT, font bootstrap and CI definition implemented | Public destination authorized: ashish200729/mandatepay. Publication/hosted CI are checked separately.                                                           |
| 1     | Prisma schema, 12 migrations, repositories, immutable history and sample seed           | Actual isolated PostgreSQL tests; samples are explicitly separated from confirmed financial data.                                                               |
| 2     | Better Auth sessions, ownership, default-off autonomy and settings audit                | Email verification/reset delivery remains a production rollout gate.                                                                                            |
| 3     | AI parse/review/draft/activation/versioned-edit/pause/resume/revoke                     | Live Sarvam structured parse succeeded; browser regression covers persistence and actions.                                                                      |
| 4     | Strict Channel3 client, immutable normalized snapshots, explicit Demo Catalog           | Channel3 key remains unconfigured; no live Channel3 claim. External discovery cannot be checked out as a demo product.                                          |
| 5     | Candidate ranking, bounded seven-tool runner, owned shopping API and server totals      | Live Sarvam ranking succeeded. Tool-loop API has mocked integration coverage; full conversational UI/live runner test remains open.                             |
| 6     | Deterministic AgentGuard and atomic spending reservations                               | Hard blocks precede approval. Reservations count across daily/weekly/monthly limits; current permission/version/price/expiry are checked before payment claims. |
| 7     | Owned approval inbox, exact product/amount/version/deadline and explicit confirmation   | Approval retries are idempotent; user confirmation satisfies approval-only reasons and cannot override a hard block.                                            |
| 8     | Sandbox-only OAuth/order/capture/reconciliation service and checkout UI                 | Live OAuth returned 200. No real Sandbox order/capture has yet been qualified; browser financial tests use an explicit simulated provider.                      |
| 9     | Signature verification, durable inbox, dedupe/lease and authoritative reconciliation    | Webhook ID is blank locally. Real registered delivery remains open. Background retry of verified pending inbox records is Phase 13 work.                        |
| 10    | Guarded full/partial refunds, stable keys, invoice binding and refund UI                | Actual PostgreSQL tests use mocked PayPal. Real Sandbox refunds remain open. Refunds do not restore gross spending permission.                                  |
| 11    | Append-only audit and owned payment/proposal/mandate/refund chain timeline              | Safe facts only are exposed; no raw provider payload or credentials in UI.                                                                                      |
| 12    | Owned analytics, full aggregates/cursor pagination, NL filters and AG Grid Community    | No fabricated savings or sample totals. AG Studio/Enterprise integration is not claimed. Live analytics-model/UI qualification remains follow-up work.          |
| 13    | Not implemented                                                                         | Stopped before edits. Next: verified-inbox retry worker, bounded backoff/leases, Render workflow/deployment and hosted qualification.                           |
| 14/18 | Incremental safety and automated checks implemented                                     | Complete production/security/provider/deployment qualification remains open.                                                                                    |
| 15–17 | Stretch features deferred                                                               | No Vault autonomy, recurrence, price watch, STT or TTS.                                                                                                         |
| 19–20 | Application UI and documentation developed                                              | Remaining final UX review and real demo/clone/hosted evidence are tracked below.                                                                                |
| 21–22 | Pending                                                                                 | Demo video and submission follow qualified live flows.                                                                                                          |

## Verification record

Verified on 2026-10-03: lint, TypeScript, **181 unit tests**, production builds, **50 actual PostgreSQL/API integration tests** (6 database + 44 API), and **7 Chromium browser tests** passed. Formatting passed. These are per-suite results, not exhaustive production or live financial qualification.

The restricted local execution environment blocked Turbopack worker port binding under Turbo's strict environment. The unchanged production app built successfully through the standalone web build and `turbo run build --env-mode=loose`; use `TURBO_ENV_MODE=loose pnpm check` in this restricted local environment. Hosted CI uses the normal root command and is recorded separately.

The browser scenario uses the real local API, actual isolated PostgreSQL, an HTTP AI fixture and an injected simulated PayPal transport. It covers mandate lifecycle, product comparison, human approval, checkout, capture, duplicate webhook, partial refund and remaining full refund. It never reads live PayPal or Channel3 keys. This is functional automated evidence, not actual Sandbox financial evidence.

A full build check uncovered concurrent Prisma generation. Database package task dependencies now build the generated client before typechecking/testing, preventing two generators from rewriting the same source concurrently.

## Publication record

The current implementation is public at [ashish200729/mandatepay](https://github.com/ashish200729/mandatepay), branch `main`. Source commit `92ab1354250234e99a38be73e5a79194008056e9` passed [hosted GitHub CI](https://github.com/ashish200729/mandatepay/actions/runs/37093692619), including a fresh dependency/font setup, migrations, checks, isolated integration and browser workflows.

Before publication, all 285 staged source/asset/documentation files were compared against actual ignored local credential values; no matches or private runtime paths were found. Environment files, local databases/credentials, generated clients, browser artifacts and the Satoshi binary were excluded. Original supplied plan and vendor licenses were preserved verbatim, including their intentional whitespace.

Publication qualifies the checked source checkpoint, not a hosted commerce service or live financial completion. The final documentation-only follow-up commit records this evidence; its CI result is available on the repository's Actions page.

## Next session

1. Read this file, README, PLAN_REVIEW and agent.md. Preserve the supplied plan and approved design.
2. Verify the recorded final check results and GitHub/CI state; do not infer release success from a local cache or an interrupted command.
3. Exercise real Sandbox buyer approval, capture and refund with a separate personal Sandbox buyer. Client credentials are already locally configured; do not request them again or paste them into chat.
4. Register a publicly reachable HTTPS webhook and set PAYPAL_WEBHOOK_ID in the ignored API environment. It was intentionally left blank while local.
5. Implement verified-pending inbox/background payment reconciliation. Public pending webhook responses are acknowledged, so recovery requires a durable worker; do not leave that gate untracked.
6. Finish the conversational shopping/refund-review UI around the completed limited agent API, and qualify live tool calls/analytics using the configured Sarvam endpoint.
7. Complete final desktop/mobile/keyboard visual review, Render deployment/workflows, hosted CI/fresh-clone verification, demo video and submission documentation.
8. Keep Vault/voice/recurrence/price-watch optional until the complete MVP is qualified.

## Configuration and guardrails

- OPENAI_MODEL is sarvam-105b; base URL is https://api.sarvam.ai/v1. Reasoning is disabled by default, bounded outputs and retries are used.
- Credentials are only in ignored apps/api/.env and packages/database/.env (0600); local cluster/credentials are under ignored .local.
- PAYPAL_ENV is sandbox-only. No real funds have moved.
- Native PostgreSQL uses loopback port 55432, separate mandatepay and mandatepay_test databases.
- Database periods use UTC; weeks start Monday. Captured gross amounts count even after refunds. Unknown provider outcomes hold reservations.
- Satoshi binary is Git-ignored and downloaded directly from Fontshare. Other font licenses and generated meadow artwork remain included.
- Sub-agents build source/tests only; the parent performs reviews.
- No credentials, generated clients, local database files, browser traces or private runtime files belong in GitHub.
