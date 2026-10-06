# Admin Phase 7 — Platform controls and kill switches

Completed and verified locally on 2026-10-07 after [payment, refund, and webhook operations](./ADMIN_PHASE_6.md). All 22 tasks and four exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). The main administrator can read and change a typed, versioned platform-setting registry. Every switch is enforced in the API that performs the action, so bypassing the admin UI does not bypass the control. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the settings contract.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P7-01–04 | `PlatformSetting` stores an allowlisted key, boolean `valueJson`, integer version, updating principal and timestamp. Migration `20261007000100_add_platform_settings` checks the key list, boolean JSON and `version >= 1`. A missing row is version 0 and uses the operating default. `compareAndSetPlatformSetting` locks the key and rejects a stale `expectedVersion`.                                                                                                                                                |
| P7-02–03 | The shared registry covers maintenance, registration, shopping agent, agent proposals, Demo Catalog, Channel3, checkout, refund initiation, global autonomy and webhook processing. Values are booleans. Unknown keys and non-booleans are rejected.                                                                                                                                                                                                                                                                      |
| P7-05–06 | `GET /api/admin/settings` and `PATCH /api/admin/settings/:key` require admin auth. The BFF allowlists those routes and applies the same origin and body checks to PATCH as to POST. `/settings` groups the switches and submits reason, version and request key.                                                                                                                                                                                                                                                          |
| P7-07–08 | `payments.autonomyEnabledGlobally` is read inside proposal evaluation and authorization revalidation. When it is off, AgentGuard requires approval through `GLOBAL_AUTONOMY_DISABLED` even if the customer’s own autonomy flag is on. The manual approval path remains available.                                                                                                                                                                                                                                         |
| P7-09–11 | Checkout is checked before a new PayPal order is created, including the provider call itself. Existing orders can still be reconciled. New refund initiation is checked in `refundPayment`, so both the customer API and admin refund route stop. Status reconciliation continues. Same-key refund retries of an already claimed refund are not treated as a new initiation.                                                                                                                                              |
| P7-12–15 | `agent.enabled` makes `POST /api/agent/chat` return a controlled unavailable response. `agent.proposalCreationEnabled` blocks the agent tool and proposal requests that carry the agent caller header. Demo Catalog and Channel3 are checked before those discovery calls. Direct customer proposal creation remains available when only the agent-proposal switch is off.                                                                                                                                                |
| P7-16–17 | Maintenance blocks new checkout, capture and new refund initiation. `/health` and `/health/ready` stay available, administration stays available, and webhook ingestion is not gated. Recovery runs during maintenance unless `workers.webhookProcessingEnabled` is explicitly false. An unreadable settings store does not stop webhook processing.                                                                                                                                                                      |
| P7-18–19 | The overview banner shows the current platform mode and links to Configuration. Disabled customer actions return a specific code and sentence: checkout, refunds, maintenance, registration, agent, agent proposals, Demo Catalog and Channel3.                                                                                                                                                                                                                                                                           |
| P7-20–22 | Maintenance, global autonomy, checkout, refund initiation and webhook processing require fresh authentication and the setting key typed exactly. Other switches require a reason and confirmation. Every successful change appends `ADMIN_FEATURE_FLAG_CHANGED` or `ADMIN_MAINTENANCE_MODE_CHANGED` with the key, boolean and version. The admin integration test hits each switch at the server enforcement point, including anonymous/non-admin denial, stale version, idempotent retry and concurrent compare-and-set. |

All four exits are satisfied: switches work without the admin UI, unreadable or invalid controls fail closed except webhook processing, maintenance does not drop provider webhooks, and the current mode is visible on the admin overview.

## Operating defaults and fail-closed behavior

A platform with no stored rows keeps today’s behavior: maintenance is off and the other switches are on. If the settings store cannot be read, or a stored value is not a boolean, checkout, refunds, autonomy, the agent, agent proposals, both discovery sources and registration are denied, and maintenance is treated as on. Webhook processing stays on unless an administrator stored `false`.

## Verification

- **351 repository unit tests** pass, including the platform-setting registry tests.
- **13 environment/server-package boundary tests** pass. Admin source and package.json still exclude server packages.
- **91 isolated PostgreSQL API integration tests** pass (12 files), including the platform-control case in `apps/api/src/admin.integration.test.ts`.
- **8 isolated database integration tests** pass.
- **Nine admin browser tests** pass against a production Next build, real API and isolated PostgreSQL test database. The new test covers the overview banner, a non-critical registration change, a critical checkout change with typed confirmation, and the resulting audit action at desktop and a 390px-wide settings view.
- Affected lint/types, production API and admin builds, source/bundle boundary checks and changed-file formatting pass. Migration `20261007000100_add_platform_settings` is applied to the local development and isolated test databases.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
node ../../node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts
```

Run the API integration command from `apps/api`, and the database integration command from `packages/database`. Windows executable shims in this workspace are incomplete, so installed CLIs are invoked directly with Node where needed.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:USERPROFILE\AppData\Local\ms-playwright"
node node_modules/@playwright/test/cli.js test --config playwright.admin.config.ts
```

## Remaining boundaries

No real administrator was selected/provisioned, and no hosting or live provider qualification is claimed. Checkout and refund enforcement tests use the API with an injected PayPal client and stop before a new provider order or refund is created. Webhook recovery during maintenance uses an injected replay. Isolated browser tests raise the admin read limiter to **2000**, the mutation limiter to **100**, and the financial limiter to **50**; production remains 120 reads, 20 mutations, and 5 financial/recovery actions per principal per 60s.

Admin cannot edit arbitrary environment variables, force a payment state, or turn webhook ingestion off. Ingestion stays available so a maintenance window does not drop provider deliveries. System health and analytics remain Phases 8 and 9.

Root formatting's known unrelated baseline and the pre-existing WebhookInbox schema/index discrepancy remain untouched. The approved customer landing page and artwork are unchanged. Customer checkout, refund, agent and discovery routes now consult these server controls before performing the gated action.
