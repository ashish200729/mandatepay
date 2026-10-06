# Admin Phase 5 — Safe user and domain controls

Completed and verified locally on 2026-10-06 after [read-only operations](./ADMIN_PHASE_4.md). All 16 tasks and three exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). Administrators can disable or restore user access, revoke sessions, turn autonomy off, add immutable notes, pause or revoke a mandate through the existing state machine, and re-evaluate a proposal through AgentGuard. None of those actions rewrite PayPal records, original prompts, or mandate permission text. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the implemented mutation contracts.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P5-01    | Additive migration `20261006000100_add_admin_user_controls` adds `User.disabledAt`, `disabledReason`, `disabledByAdminId`, `accessVersion`, and immutable `AdminNote`. `USER_DISABLED` / `USER_ENABLED` / `USER_SESSIONS_REVOKED` join domain audit; `ADMIN_PROPOSAL_RE_EVALUATED` joins admin audit.                                                        |
| P5-02    | Disabled accounts are rejected on Better Auth credential sign-in (`ACCOUNT_DISABLED`), customer `/api/me` and other authenticated business routes, admin `requireAdmin`, and proposal evaluation unless an admin re-eval explicitly allows a disabled owner. Disable also deletes that user's sessions.                                                      |
| P5-03–05 | `POST /users/:id/disable`, `/enable`, `/revoke-sessions`. Disable and session revoke require fresh auth plus typed target ID. The singleton administrator cannot be disabled. Enable restores access; it does not recreate sessions.                                                                                                                         |
| P5-06    | `POST /users/:id/disable-autonomy` uses the existing locked user update and `GLOBAL_AUTONOMY_UPDATED` domain audit. It never enables spending.                                                                                                                                                                                                               |
| P5-07–08 | **Decision:** admin may pause and revoke. Both call `MandateRepository.pauseInTransaction` / `revokeInTransaction` with expected version and current status. Admin cannot resume, edit permissions or limits, or force-allow a proposal. Fresh auth and typed mandate ID are required.                                                                       |
| P5-09    | `POST /proposals/:id/re-evaluate` calls `evaluateProposalInTransaction`. Supported states remain `PROPOSED` / `POLICY_CHECKED` / `AWAITING_APPROVAL`. Sample, terminal, blocked-reset and stale expected-status rows return 409. AgentGuard still decides ALLOW / REQUIRE_APPROVAL / BLOCK.                                                                  |
| P5-10    | `GET/POST /users/:id/notes`. Note body is 1–2000 characters; author principal ID is a historical snapshot without a cascading FK. Entries are append-only.                                                                                                                                                                                                   |
| P5-11–14 | Every mutation requires a 1–255 character reason, UUID `requestKey`, and expected updatedAt/accessVersion or mandate version/status. Claim, concurrency check, domain change and admin audit commit in one database transaction. Idempotent retries fingerprint request identity, not live before-state. Validation failures roll back so the key can retry. |
| P5-15–16 | Isolated API integration covers lockout, missing reason, stale concurrency, sample rejection, AgentGuard re-eval, pause/revoke, enable/disable/sessions and audit visibility. Admin Chromium covers notes, autonomy off, re-eval, pause, disable and audit actions without rendering original prompts.                                                       |

All three exits are satisfied: the main admin can intervene in user access, mandate and proposal actions reuse existing policy/lifecycle services, and each mutation is visible in admin audit.

## Verification

- **346 repository unit tests** pass, including operations DTO, mutation parse and BFF allowlist tests.
- **13 environment/server-package boundary tests** pass. Admin source and package.json still exclude server packages.
- **89 isolated PostgreSQL API integration tests** pass (12 files), including the controls case in `apps/api/src/admin.integration.test.ts`.
- **8 isolated database integration tests** pass.
- **Seven admin browser tests** pass against a production Next build, real API and isolated PostgreSQL test database. Existing identity/BFF/session/foundation/operations tests still pass. The controls test follows note → disable-autonomy → AgentGuard re-eval → pause → disable and asserts those admin audit actions without original prompts.
- Affected lint/types, production admin build, source/bundle boundary checks and changed-file formatting pass. Migration `20261006000100_add_admin_user_controls` is applied to the local development and isolated test databases.

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

No real administrator was selected/provisioned, and no hosting or live provider qualification is claimed. Mutable financial fixtures are cleaned up; immutable notes, synthetic PolicyDecision, MandateVersion, MandateRule, ProductSnapshot and audit rows deliberately remain in the isolated test database. Isolated browser tests raise the admin read limiter to **2000** and the mutation limiter to **100**; production remains 120 reads and 20 mutations per principal per 60s. The extra read budget is required because Phase 5 adds more authenticated page loads on the shared fixture principal.

Admin resume, permission edits, force-ALLOW, payment/refund/webhook mutations and platform settings remain Phase 6+. Re-evaluation of a paused or revoked mandate is invalid; AgentGuard still requires an active mandate. Enabling an account does not restore revoked sessions.

Root formatting's known unrelated baseline and the pre-existing WebhookInbox schema/index discrepancy remain untouched. The approved customer landing page/artwork and financial services are unchanged.
