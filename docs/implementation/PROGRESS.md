# Phase progress and handoff

Checkpoint: 2026-10-03. The user resumed implementation. Hosted deployment and live Sandbox buyer verification were subsequently deferred explicitly; local implementation and verification continued. TypeScript/Node only. New sub-agent build tasks use GPT-6.1-sol with high reasoning; the parent performs reviews.

## Current implementation

The project is TypeScript/Node only. The approved landing page, shared warm theme, fonts and artwork are preserved. Implemented application surfaces include signup/signin, mandates, discovery/comparison, approvals, Sandbox checkout, order receipts, full/partial refunds, audit timeline and AG Grid Community Control Center.

The API wires mandate, catalog, proposal, payment, refund, verified-webhook, analytics and limited shopping-agent routes. Conversational shopping/refund review, account recovery, dashboard detail navigation and verified-inbox recovery are now implemented. Provider/deployment qualification is tracked separately from working local code.

## Phase ledger

| Phase | Current state                                                                           | Qualification boundary                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | pnpm/Turbo, tests, native PostgreSQL, MIT, font bootstrap and CI definition implemented | Public destination authorized: ashish200729/mandatepay. Publication/hosted CI are checked separately.                                                           |
| 1     | Prisma schema, 13 migrations, repositories, immutable history and sample seed           | Actual isolated PostgreSQL tests; samples are explicitly separated from confirmed financial data.                                                               |
| 2     | Sessions, ownership, default-off autonomy, verification/resend and password reset       | Production requires verified email and a configured sender. Actual PostgreSQL tests use fake mail delivery; live Resend delivery is unverified.                 |
| 3     | AI parse/review/draft/activation/versioned-edit/pause/resume/revoke                     | Live Sarvam structured parse succeeded; browser regression covers persistence and actions.                                                                      |
| 4     | Strict Channel3 client, immutable normalized snapshots, explicit Demo Catalog           | Channel3 key remains unconfigured; no live Channel3 claim. External discovery cannot be checked out as a demo product.                                          |
| 5     | Ranking, bounded seven-tool runner, conversational shopping UI and server-owned totals  | Live Sarvam parsing/ranking and a payment-free tool loop succeeded. Purchase authority remains server-owned; refund lookup works without an active mandate.     |
| 6     | Deterministic AgentGuard and atomic spending reservations                               | Hard blocks precede approval. Reservations count across daily/weekly/monthly limits; current permission/version/price/expiry are checked before payment claims. |
| 7     | Owned approval inbox, exact product/amount/version/deadline and explicit confirmation   | Approval retries are idempotent; user confirmation satisfies approval-only reasons and cannot override a hard block.                                            |
| 8     | Sandbox-only OAuth/order/capture/reconciliation service and checkout UI                 | Live OAuth returned 200. No real Sandbox order/capture has yet been qualified; browser financial tests use an explicit simulated provider.                      |
| 9     | Signature verification, durable inbox, dedupe/lease and authoritative reconciliation    | Verified-only recovery worker added. Real registered HTTPS delivery remains deferred.                                                                           |
| 10    | Guarded full/partial refunds, stable keys, invoice binding and refund UI                | Actual PostgreSQL tests use mocked PayPal. Real Sandbox refunds remain open. Refunds do not restore gross spending permission.                                  |
| 11    | Append-only audit and owned payment/proposal/mandate/refund chain timeline              | Safe facts only are exposed; no raw provider payload or credentials in UI.                                                                                      |
| 12    | Analytics/NL filters, AG Grid, loaded-row mandate/day/week charts and record drilldown  | Live Sarvam analytics parsing succeeded. Charts disclose loaded-row scope and use capture dates. AG Studio/Enterprise is not integrated.                        |
| 13    | Verified-inbox worker, bounded backoff/leases and optional Render deployment template   | Local recovery tests pass. Hosting deferred; template uses Cron Jobs, not Render Workflows SDK. No hosted acceptance claim.                                     |
| 14/18 | Financial rate limits, token-log redaction, web headers, auth recovery and threat model | Local automated verification; live provider, hosted, email delivery and operational acceptance remain open.                                                     |
| 15–17 | Stretch features deferred                                                               | No Vault autonomy, recurrence, price watch, STT or TTS.                                                                                                         |
| 19–20 | Functional UI, architecture/threat model, setup/deployment docs and Postman collection  | Parent desktop/mobile review and current exact local verification are recorded below. Postman collection provided but not run live.                             |
| 21–22 | Demo runbook and presentation outline prepared                                          | Final recorded video and hackathon submission remain pending after live qualification.                                                                          |

## Verification record

Resumed MVP batch verified on 2026-10-03: the normal strict-mode `pnpm check` passed lint, TypeScript, production Turbopack builds and **235 unit tests**, plus **11 environment-loader tests**. The isolated PostgreSQL suite passed **60 integration tests** (6 database + 54 API), including verification gating for existing sessions. The complete Chromium suite passed **8 browser tests** after correcting two selectors to use the controls' accessible roles. It covers conversational proposal decisions, multiple-mandate selection, read-only dashboard filters/detail links and refund draft handoff without execution before confirmation, in addition to the earlier payment lifecycle.

Live `sarvam-105b` checks succeeded for a bounded three-round shopping tool loop using payment-free demo tools and analytics parsing of “Show purchases above $100.” The result preserved `gt`, 10000 cents, no requested date range and table intent. A provider `tool_calls: null` final response initially failed strict parsing; the compatibility fix retains strict validation of actual calls and has regression tests. These checks are model capability evidence, not live purchase/payment evidence.

Parent visual review inspected desktop/mobile chat and desktop dashboard screenshots from the actual browser scenario; mobile chat has no document-level horizontal overflow. The approved palette/fonts/landing artwork are preserved. Deterministic UI detector returned no findings; its ignored initial design-phase marker remains stale and is not qualification evidence. Formatting, final whitespace/credential checks and publication status are recorded with the final handoff below.

Verified on 2026-10-03: lint, TypeScript, **181 unit tests**, production builds, **50 actual PostgreSQL/API integration tests** (6 database + 44 API), and **7 Chromium browser tests** passed. Formatting passed. These are per-suite results, not exhaustive production or live financial qualification.

The restricted local execution environment blocked Turbopack worker port binding under Turbo's strict environment. The unchanged production app built successfully through the standalone web build and `turbo run build --env-mode=loose`; use `TURBO_ENV_MODE=loose pnpm check` in this restricted local environment. Hosted CI uses the normal root command and is recorded separately.

The browser scenario uses the real local API, actual isolated PostgreSQL, an HTTP AI fixture and an injected simulated PayPal transport. It covers mandate lifecycle, product comparison, human approval, checkout, capture, duplicate webhook, partial refund and remaining full refund. It never reads live PayPal or Channel3 keys. This is functional automated evidence, not actual Sandbox financial evidence.

A full build check uncovered concurrent Prisma generation. Database package task dependencies now build the generated client before typechecking/testing, preventing two generators from rewriting the same source concurrently.

## Publication record

The current implementation is public at [ashish200729/mandatepay](https://github.com/ashish200729/mandatepay), branch `main`. Source commit `92ab1354250234e99a38be73e5a79194008056e9` passed [hosted GitHub CI](https://github.com/ashish200729/mandatepay/actions/runs/37093692619), including a fresh dependency/font setup, migrations, checks, isolated integration and browser workflows.

Before publication, all 285 staged source/asset/documentation files were compared against actual ignored local credential values; no matches or private runtime paths were found. Environment files, local databases/credentials, generated clients, browser artifacts and the Satoshi binary were excluded. Original supplied plan and vendor licenses were preserved verbatim, including their intentional whitespace.

Publication qualifies the checked source checkpoint, not a hosted commerce service or live financial completion. The final documentation-only follow-up commit records this evidence; its CI result is available on the repository's Actions page.

## Deferred qualification and next session

1. Read this ledger and README; preserve the supplied plan and approved design. Respect the user's explicit deferral of hosted deployment and live Sandbox buyer verification until resumed.
2. When resumed, exercise real buyer approval/capture/refund, register HTTPS webhooks and qualify actual recovery delivery. Existing client credentials are configured; do not request them again or paste secrets into chat.
3. Configure a verified email sender, qualify delivery and production recovery, then deploy the reviewed template only when hosting is resumed. Monitor exhausted verified events and unknown financial holds; no timeout-based hold release.
4. Verify fresh-clone and current hosted CI evidence separately from earlier published checkpoints. Record the final demo video and submit only after required real provider evidence is available.
5. Channel3 live discovery, AG Studio/Enterprise and Render Workflows remain separate unqualified integrations. Keep Vault/voice/recurrence/price-watch optional; they are not working switches.

## Configuration and guardrails

- OPENAI_MODEL is sarvam-105b; base URL is https://api.sarvam.ai/v1. Reasoning is disabled by default, bounded outputs and retries are used.
- Existing credentials remain in ignored apps/api/.env and packages/database/.env (0600); local cluster/credentials are under ignored .local. Shared root environment files are now supported; the added ignored root .env contains nonsecret defaults and also has mode 0600.
- PAYPAL_ENV is sandbox-only. No real funds have moved.
- Native PostgreSQL uses loopback port 55432, separate mandatepay and mandatepay_test databases.
- Database periods use UTC; weeks start Monday. Captured gross amounts count even after refunds. Unknown provider outcomes hold reservations.
- Satoshi binary is Git-ignored and downloaded directly from Fontshare. Other font licenses and generated meadow artwork remain included.
- Sub-agents build source/tests only; the parent performs reviews.
- No credentials, generated clients, local database files, browser traces or private runtime files belong in GitHub.

## Environment support follow-up — 2026-10-03

The user requested review and implementation of global and workspace-specific environment support. Root `.env` defaults now feed the API, web server and Prisma tooling, with workspace overrides and shell/CI/deployment values taking precedence. Mode-specific/local files are supported; generic `.env.local` is skipped for test consumers. Empty overrides intentionally clear inherited settings. Existing local credentials were preserved.

The API startup loader accepts supported runtime keys only. Next.js imports only root `API_URL` / `APP_URL`; provider/auth/database secrets are excluded. Its strict Turbo task environment also excludes backend keys. Database commands and isolated integration/E2E configuration import database URLs only. Unit-test workers do not load private files. Turbo accounts for environment-file changes and previously omitted AI/Channel3 development knobs. Setup and precedence are documented in [environment configuration](../development/environment.md), with updated root/workspace examples.

Verified: 11 environment regression tests, lint, TypeScript, existing unit suites, strict-mode production build, 50 isolated PostgreSQL/API integration tests and 7 Chromium browser tests passed. A separate dummy-file smoke check verified the tsx development watcher preload. Formatting, Git whitespace checks, ignored-file status and 0600 permissions passed; changed source was compared against configured local credential values with zero matches.

The first restricted build and integration attempts failed because the sandbox denied worker-port/database access. The same source passed after granting local execution access. This environment follow-up was local and uncommitted at that checkpoint, and was retained in the resumed batch. Legacy full `.env` loading was removed from API integration workers; their configuration now loads database keys only. Live-provider and hosting gates remain separate.

## Resumed implementation changes

- Conversational shopping calls only the existing limited server tools. Multiple mandates need a deliberate selection. Refund lookup is independent of a new purchase mandate; a five-minute, one-time browser draft prefills an owned order's refund form without submitting it.
- Proposal retries read already evaluated facts instead of evaluating/reserving again. Transaction search filters owned records in the database before applying its result bound. The model sees validated canonical mandate rules; identity and financial facts remain server-owned.
- Dashboard links distinguish local payment IDs from proposal IDs. Proposal-only/blocked records have read-only policy/audit detail. Captured charts use capture dates and disclose loaded-row scope.
- Verified inbox recovery adds a migration, concurrent-safe leases, backoff and five-attempt limit. Replay does not release a lease before its result is persisted, and unsigned records are excluded. The worker performs authoritative reads, not new capture/refund operations.
- Production auth requires verified-email delivery, including existing unverified sessions when verification is enabled. Reset identifiers are hashed, tokens are short-lived/single-use and reset revokes sessions. Fake-sender actual PostgreSQL tests cover concurrency, expiration, reuse, ownership/callbacks and enumeration-resistant delivery failure.
- Auth query/path tokens are redacted from API logs. Financial mutation rate limits and web security headers were added. Environment work present at the start was retained and integrated.
- Architecture diagram, threat model, manual Postman collection, optional Render Blueprint and demo/submission runbook are supplied. Render deployment/live buyer verification remain explicitly deferred. No Render Workflows, AG Studio, Vault or voice integration is claimed.

Final local source review found no whitespace errors. Formatting passed. All 324 tracked/non-ignored source, asset and documentation paths and the browser static bundle were checked against configured private credential values: zero matches. Private environment files remain ignored. The configured development database has all 13 migrations applied. Publication and current hosted CI are checked against the exact Git commit rather than inferred from earlier checkpoint runs.
