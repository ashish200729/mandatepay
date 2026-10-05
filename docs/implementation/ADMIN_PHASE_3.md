# Admin Phase 3 — UI foundation

Completed and verified locally on 2026-10-06 after [security](./ADMIN_PHASE_1.md) and [audit](./ADMIN_PHASE_2.md). All 24 tasks and three exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). The protected session page now uses the complete responsive shell. Reusable collection, state, event and sensitive-action components are ready for Phases 4–9. [The component contract](../architecture/admin-ui.md) documents integration, pagination, UTC dates, safe summaries and backend responsibilities.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-01    | Existing admin dev/build/start/lint/typecheck/test scripts align with Next 16.3.8, strict TypeScript, shared UI/theme and Turbo. Verified the production build, unit runner and boundary gate; the approved environment label is included in root imports/Turbo task environments. No new dependency is required.                                |
| P3-02–03 | Shared Button/Separator and a shared accessible Radix Dialog primitive. Admin CSS adds semantic sidebar/active/success/warning/danger/info tokens while retaining the approved warm palette and fonts.                                                                                                                                           |
| P3-04–06 | Authorized `AdminShell`, independent desktop sidebar scrolling, modal tablet/mobile navigation, sticky top bar, explicit deployment environment badge and administrator identity. Planned modules are disabled and labeled Soon; only implemented session navigation is enabled.                                                                 |
| P3-07–10 | Reusable breadcrumbs/current page, page header, metric cards, status badges and health indicator. Unavailable values render an explanation and em dash; status remains textual.                                                                                                                                                                  |
| P3-11–13 | Typed server-driven table/cards with exact detail anchors, opt-in server sorting, search/enum/UTC date controls and opaque-cursor pagination. No page-local sorting/filtering substitutes for server results or fabricated global totals.                                                                                                        |
| P3-14–15 | Local and route loading skeletons, actual empty results, accessible errors and retry handlers. Failed/malformed audit data is an error, not an empty timeline.                                                                                                                                                                                   |
| P3-16–19 | Confirmation, required reason, high-risk exact typed target/fresh authentication/final review and real password reauthentication dialogs. Passwords clear immediately; wrong-password errors remain usable. Busy actions cannot be submitted twice or dismissed. Submitted input/request keys persist through retry and reopening while mounted. |
| P3-20–21 | Safe projected audit/event timeline, bounded entity links, expandable allowlisted summary viewer and dismissible notifications with distinct pending/success/error outcomes.                                                                                                                                                                     |
| P3-22    | URL query validation, reset-on-view-change cursors, bookmark/reload/back restoration, bounded local Previous history and preserved precise date bounds on unrelated filter edits.                                                                                                                                                                |
| P3-23–24 | Browser keyboard/focus/disabled/loading/empty/error/dialog tests and screenshots at desktop 1280px, tablet 768px and mobile 390px. Complete mobile cards, responsive filters/dialogs, 44px actions, drawer Escape/link/scrim dismissal and absence of horizontal document overflow are verified.                                                 |

All three exits are satisfied: later modules can import the common components, sensitive actions have a standard reviewed flow, and the server-driven table/filter/dialog integration pattern is documented. This phase enables no operational mutation or overview/audit page. The existing session page and real password confirmation are the live admin surface.

## Verification

- **339 repository unit tests** pass, including seven new query/environment/error/gated-fixture tests. Query tests cover allowed parameters, invalid boundaries, cursor resets, inclusive UTC dates and precise timestamp preservation.
- **13 environment/server-package boundary tests** pass. Admin environment imports exclude secrets and the fixture activation flag.
- **Five admin browser tests** pass against a production Next build, real API and isolated PostgreSQL test database. Existing real identity/BFF/audit reads, expiry/revocation and password session rotation still pass. New tests cover server-driven fixture filtering/sorting/pagination/detail links, redaction, keyboard dialogs, wrong-password recovery, typed/fresh review, generic unknown errors, stable retry/reopen request keys and tablet/mobile behavior.
- Admin/shared UI/browser TypeScript, affected ESLint, admin production build, source/bundle boundary checks, changed-file formatting and whitespace checks pass. No schema or dependency/lockfile change is required.
- Screenshots were inspected for the session page, shared desktop foundation, sensitive final review and tablet/mobile records. New success/warning/danger/info foreground/background pairs have measured contrast ratios **7.21 / 6.32 / 7.03 / 6.62**, exceeding 4.5:1. Keyboard and semantic checks are automated; this is not a claim of an external accessibility certification or screen-reader audit.

The synthetic `/ui-fixtures` routes require the normal admin guard plus three server gates: `ADMIN_UI_FIXTURES=1`, `ADMIN_ENVIRONMENT=test`, and a loopback admin origin. Disabled gates are unit-tested. The isolated harness sets them directly on its own Next process. Fixture records and action outcomes are simulated and explicitly labeled; they neither calculate operational metrics nor invoke business actions. The nested high-risk password response is simulated for deterministic UI coverage; the actual password endpoint/session rotation is verified separately in the real session browser flow.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
node node_modules/@playwright/test/cli.js test --config playwright.admin.config.ts
```

Run admin ESLint and Next build/type generation in `apps/admin`, shared UI ESLint/TypeScript in `packages/ui`, and formatting on the changed files. The admin package's `test` script also selects its tests through the root Vitest config. Windows executable shims in this workspace are incomplete, so installed CLIs were invoked directly with Node. API/database integration suites were qualified in Phase 2 and were not rerun as new Phase 3 evidence; these browser tests exercise the actual unchanged API/database session paths. Principal-owning fixtures must run sequentially against the same dedicated test database.

Captured artifacts are ignored local files under `test-results`, including `desktop-session.png`, `desktop-foundation.png`, `desktop-sensitive-review.png`, `768-foundation.png` and `390-foundation.png` in their corresponding test directories. Browser output regenerates them on each run; no fixture identities or screenshots are published.

## Remaining boundaries

No real administrator was selected/provisioned, and no hosting or live provider qualification is claimed. Mutable browser fixtures are cleaned up; immutable synthetic audit events deliberately remain in the isolated test database. Backend adapters in later phases must enforce authorization, freshness, current-state/concurrency checks, durable idempotency across reloads and atomic audit/domain outcomes. UI validation alone grants no authority.

Phases 4–10 remain planned. Root formatting's known unrelated baseline and the pre-existing WebhookInbox schema/index discrepancy remain untouched. The approved customer landing page/artwork and financial services are unchanged.
