# Implementation plan review

Reviewed on 2026-10-02. The parent agent handles current reviews; sub-agents are used only for implementation and tests, as the user requested. No supplied product/plan document was rewritten.

## Source documents

- `MandatePay_AgentGuard_End_to_End_Implementation_Plan.md`: the complete 3,375-line, 56,907-byte implementation plan, including Phases 0–22, API map, state machines, rule matrix, audit catalog, feature flags, demo and submission criteria. SHA-256: `a15c33a23328e6d6781ef83007d04e8b83cdfbf8eb8dcfd904b4ebe53b889882`.
- `/Users/ashish/Downloads/file.md`: the complete 2,702-line, 45,416-byte product brief. SHA-256: `559f8c35b5ad0015fb5c980fe181b7eca9033767723a7ff960ef8904102fc62f`. This is a different document, not a replacement for the detailed root plan.
- `AGENTS.MD` and `agent.md`: repository workflow and acceptance-evidence instructions.
- The user's judging-requirement screenshot: working interactive build; complete local setup instructions or a hosted demo; truthful explanation of tools used; public open-source GitHub source/assets/instructions with a visible root license.

## Product understanding

MandatePay delegates a class of permitted purchases, not unrestricted access to money. AI interprets intent, discovers/ranks products, and creates proposals. AgentGuard deterministically enforces permissions. PayPal performs authorized money movement. Database state, reservations, approvals, verified provider events, and an immutable audit trail connect those responsibilities.

The complete MVP includes authentication, reviewable/versioned mandates, discovery and demo merchant mapping, server-computed proposals, three policy outcomes, approval, real Sandbox orders/captures/webhooks/refunds, audit inspection, data-backed analytics, and a runnable release. Saved-wallet autonomy, recurrence, price watch, voice, negotiation, and Store Sync are stretch work; they cannot gate the MVP.

## Resolved implementation choices

The user explicitly confirmed TypeScript and Node.js only. The existing Fastify/Next.js stack, Prisma and PostgreSQL remain authoritative; no Python backend is being introduced.

The user authorized `ashish200729/mandatepay` as the public GitHub destination. Publication and hosted CI must be verified before their gates are marked complete.

AI configuration uses server-only `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`. Sarvam `sarvam-105b` on its V1 endpoint is configured locally and a live structured mandate parse succeeded. This is text inference; STT/TTS are later optional voice capabilities. The user now allows concise questions for essential inputs.

## Contracts to make explicit during implementation

These are review findings and required engineering resolutions, not claims that the contracts have been implemented.

| Finding                                                                                        | Plan reference                                       | Required resolution                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monetary examples use unrestricted JS numbers/decimal language                                 | Phase 1 exit gate; canonical mandate/product schemas | Use integer minor units and explicit supported currency/exponent rules, as repository guidance requires. Reject unsafe/non-finite/negative values and recompute totals server-side.                                                  |
| Proposal and approval records omit some authorization bindings                                 | Phases 1, 6, 7                                       | Bind to exact mandate version, immutable product/amount/currency, authenticated owner, reservation, and expiry. Revalidation must create fresh authorization when bindings change.                                                   |
| `APPROVED` to `AUTHORIZED` is underspecified                                                   | Proposal state machine; Phase 8 order guard          | Require a checked server transition after approval/revalidation. Human approval alone cannot override hard blocks.                                                                                                                   |
| Reservations happen before pending approval in Phase 6 but after approval in the final example | Phase 6.6; final example steps 11–12                 | Adopt one documented transaction contract. Count confirmed spend and other active reservations once; exclude the proposal's own reservation during revalidation. Define approval TTL and settlement/release/reconciliation behavior. |
| Reservation/payment timeout can have an unknown provider outcome                               | Phases 8–9, 13                                       | Do not release reserved funds or retry money movement as a new operation while capture/refund outcome is unknown. Reconcile with verified provider state and idempotency keys.                                                       |
| The listed data model has no webhook inbox/event uniqueness                                    | Phase 9                                              | Persist verified event identity and processing state; deduplicate atomically and handle out-of-order delivery.                                                                                                                       |
| Refund model lacks complete concurrency and accounting fields                                  | Phase 10                                             | Bind ownership, currency and confirmation; reserve refundable amounts atomically; prevent concurrent over-refunds and duplicate submissions.                                                                                         |
| New-merchant approval exists only in the rule matrix                                           | Rule matrix; Phases 3/6                              | Add explicit mandate/user controls, merchant identity/history, and reason codes. Unknown restricted metadata must not be silently accepted.                                                                                          |
| Aggregate period boundaries and currencies are not specified                                   | Daily/weekly/monthly rules                           | Define timezone, week/month boundaries, currency matching, rounding and cumulative accounting, with boundary tests.                                                                                                                  |
| User/global kill switches and feature flags overlap                                            | Phases 2/14; environment and feature flags           | Hard blocks take precedence. Disable autonomy for otherwise eligible proposals; disabling an optional provider must not manufacture successful execution.                                                                            |
| Phase order and module order differ                                                            | Phase list; Sections 6 and 21                        | Track phase outcomes while respecting the explicit safety dependency: deterministic, tested AgentGuard precedes real payment execution.                                                                                              |
| Security and testing are placed late in the numbered list                                      | Phases 14/18                                         | Build ownership, validation, safe logs, idempotency and tests into each relevant phase. They gate public hosting, not a post-launch cleanup.                                                                                         |

The plan's mandatory policy inequalities use `total <= autoSpendLimit` and `total <= transactionLimit`. Test below, exactly at, and above these boundaries. Product rules, inactivity/revocation/expiry, and cumulative-limit failures remain `BLOCK` even if autonomy is disabled.

## Current readiness

The landing page, authentication, global autonomy setting, mandate parser/review/draft/activation/versioned-edit/pause/revoke flows and PostgreSQL persistence are implemented. Tests cover unit, isolated database integration and browser flows. Deterministic AgentGuard is built separately from inference. Purchase discovery, policy orchestration, financial execution and analytics still have independent gates. Local mandate functionality does not establish the complete financial demo requirement.

Native PostgreSQL 17 runs in an isolated loopback cluster on port 55432 with separate development/test databases. Vitest and Playwright are configured. Browser tests use ports 3100/4100/4200 and the dedicated test database; live provider qualification remains separate. Public hosted CI and Render deployment have not yet been qualified.

The supplied plan was added after the existing formatting checks were set up and is not Prettier-formatted. It is now excluded by exact filename to preserve the user's authoritative input verbatim; maintained code and implementation documentation remain format-checked.

## Public-release asset issue

Satoshi's binary is excluded from Git and downloaded directly from the official vendor during web setup. The approved typography remains intact and the repository does not redistribute that binary. Other fonts retain their included OFL licenses. See `THIRD_PARTY_NOTICES.md` and `scripts/setup-fonts.mjs`.

## Inputs for subsequent provider-qualified phases

Do not paste secrets into chat or commit them. Supply configuration through local ignored environment files or the deployment's secret settings when the matching phase begins.

- Channel3 API access/key for live discovery; explicit Demo Catalog mode can support local discovery while this is unavailable.
- PayPal Sandbox REST app client ID/secret, merchant and buyer accounts, return/cancel URLs, webhook registration ID, and publicly reachable verification endpoint.
- AG Grid/AG Studio license/access for selected licensed features; document any community fallback honestly.
- Render account/service/domain and deployment configuration for hosted and workflow gates.
- Production email verification/recovery delivery and final security/deployment qualification before exposing real account/payment workflows.

Live Sarvam text parsing/ranking and PayPal Sandbox OAuth have evidence. Local implementation now includes commerce, refund, verified-webhook and analytics services; current automated financial tests use simulated providers. Real buyer/capture/refund/webhook, Channel3, AG Studio and Render qualification remain open. Sandbox client credentials are already configured locally; do not request them again. Credentials belong in ignored environment files and must not appear in documentation, source, logs or screenshots.

The plan permits a labeled demo catalog fallback for discovery and a standard PayPal payer-approval fallback when vaulting is unavailable. It does not permit claiming mock capture/refund/webhook results as real Sandbox evidence.

## Admin Phase 0 review — 2026-10-05

The user authorized verification and completion of Admin Phase 0 in `MandatePay_Admin_Implementation_Plan.md`. The complete plan and current code were reviewed; evidence is in [ADMIN_PHASE_0.md](./ADMIN_PHASE_0.md), and the fixed consumption/security design is in [admin-api.md](../architecture/admin-api.md). All 14 verification items and four exit criteria are complete. The plan's existence check now records the actual absent admin scaffold; configuration alignment is specified for Phase 1/3, not falsely reported as an existing app.

The contract uses Better Auth through an admin same-origin BFF with API-enforced verified singleton authorization and server-side idle/fresh-auth proof. Phase 1 needs AdminPrincipal/AdminRole and AdminSessionSecurity migrations plus exact admin-origin configuration. Existing domain audit has no separate admin actor, so Phase 2 will add AdminAuditEvent with append-only database protection. Account disable, notes, platform controls, worker heartbeat and complete agent/delivery telemetry have identified later-phase additions; unavailable metrics cannot be shown as zero.

Orders are Payment projections, not a new order table. Runtime mandate revocation differs from the shared map; refund runtime supports CANCELLED beyond the shared enum. Recovery uses verified row-locked claims with existing leases/attempt caps, not generic inbox setters. Domain service reuse, DTO redaction, sample exclusions and exact metric definitions are documented. Phase 0 implemented no admin page, route or migration. The supplied admin plan is excluded by exact filename from Prettier to preserve its text apart from authorized completion annotations.

## Admin Phase 1 review — 2026-10-05

The user authorized the security foundation after Phase 0. The singleton AdminPrincipal/AdminRole and session-security migration, verified-user bootstrap, authoritative API guards, idle/fresh-auth proof, session rotation/revocation, exact origins and dedicated rate limits now implement the fixed contract. The admin Next scaffold provides only guarded authentication/session states. Database and provider packages are excluded from its dependency/import graph; server-only modules and emitted browser assets were checked.

[ADMIN_PHASE_1.md](./ADMIN_PHASE_1.md) records passing unit, real database/API and desktop/mobile browser verification, setup and local limitations. The real main account is an operator-supplied existing verified identity, not an invented email/password. Test fixture principals were removed. Phase 1 is checked; Phases 2–10 remain unimplemented. Security logs do not substitute for Phase 2 immutable admin audit. Next's current proxy convention satisfies the middleware requirement. Configured HTTPS Origin is checked against incoming Host so TLS termination cannot break legitimate sign-in; caller-controlled forwarding headers grant no authority.
