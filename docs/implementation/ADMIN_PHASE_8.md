# Admin Phase 8 — System health, worker, and AI observability

Completed and verified locally on 2026-10-07 after [platform controls](./ADMIN_PHASE_7.md). All 17 tasks and four exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). An administrator can see which subsystem is degraded without reading credentials, prompts, or model reasoning. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the health and agent-run contracts.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P8-01–02 | `GET /api/admin/system/health` aggregates API, database, worker, webhook, PayPal, Channel3, Demo Catalog, and agent status. The API component is ready when the process answers. PostgreSQL is a `SELECT 1` with latency; slower than one second is degraded, and a failed check is unavailable. Unconfigured integrations are excluded from the overall status. |
| P8-03    | Each webhook recovery run writes `WorkerHeartbeat` with worker name, run id, start, heartbeat, completion, outcome, and batch counts. No row is unknown. A heartbeat older than 15 minutes, a failed run, or a skipped run because processing is off is degraded.                                                                                                |
| P8-04–06 | Webhook health reports the same due-now backlog as the worker, failed verified rows, and scheduled retries with attempts under five. Last success is the latest processed inbox time, the latest successful worker completion, and the latest successful admin reconciliation audit.                                                                             |
| P8-07    | `PayPalClient.probeSandbox` performs Sandbox OAuth and returns only status, a closed code, and latency. The access token, client id, and client secret are not in the result. A missing client is unknown, not healthy. Probes are cached for 30 seconds.                                                                                                        |
| P8-08–09 | Channel3 health is a bounded search whose body is discarded. No API key means unknown. Demo Catalog health is the in-process catalog. A kill switch is an `enabled` field, separate from whether the catalog or provider responds.                                                                                                                               |
| P8-10–12 | Shopping runs that enter the model loop write `AgentRunMetric` and `AgentToolMetric`: request id, user, safe model id, timing, outcome, error class, tool name/outcome, and proposal or refund-draft payment id. Error classes are timeout, provider unavailable, invalid response, tool failure, rate limited, cancelled, or unknown.                           |
| P8-13–16 | `/system` and `/agent` are linked from the shell. The system page shows component status, worker counts, and API commit/build version, or “Not recorded” when no safe SHA or version is set. `/agent` lists runs and metrics. The overview renders a warning card for every component that is not ready.                                                         |
| P8-17    | Telemetry records are checked before insert. Message, prompt, arguments, reasoning, and secret-shaped strings are rejected. The admin integration test sends a prompt field and expects the write to fail, then reads a safe run and checks the response does not contain that prompt.                                                                           |

All four exits are satisfied: subsystem status is visible, API, database, PayPal, webhook, discovery, and agent failures use different components, worker liveness and backlog are on `/system`, and probes and stored runs do not include credentials or chain-of-thought.

## Storage

Migration `20261007000200_add_operational_telemetry` adds `WorkerHeartbeat`, `AgentRunMetric`, `AgentToolMetric`, and `WebhookDeliveryMetric`. Checks limit worker names, tool names, model ids, request ids, counts, and event types. There is no column for a transcript, tool argument, or provider token.

## Verification

- **359 repository unit tests** pass, including observability schema tests and the PayPal probe test that the token is absent from the result.
- **13 environment/boundary tests** pass. Admin source still excludes server packages.
- **21 admin API integration tests** pass, including anonymous denial of system health and a safe agent-run read.
- The webhook recovery integration file passed in this session before formatting. It still completes a batch; the worker now also writes a heartbeat.
- **Ten admin browser tests** pass against a production Next build, the real API, and the isolated PostgreSQL test database. The new test covers `/system`, `/agent`, and overview subsystem warnings at 390px and 1280px. The operations overview assertion now expects recorded agent-run counts instead of the old unavailable placeholder.
- Production API and admin builds pass. The migration is applied to the local development database `mandatepay` and the isolated test database `mandatepay_test`.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
```

Run the admin integration command from `apps/api`. Windows executable shims in this workspace are incomplete, so installed CLIs are invoked directly with Node where needed.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:USERPROFILE\AppData\Local\ms-playwright"
node node_modules/@playwright/test/cli.js test --config playwright.admin.config.ts
```

The browser command expects a current production build of `@mandatepay/api` and `@mandatepay/admin`.

## Remaining boundaries

No real administrator was selected or provisioned, and no hosting or new live-provider qualification is claimed. PayPal and Channel3 probes in automated tests are injected or mocked. A configured live key is probed only when an administrator opens system health, and the result is cached. Provider health history is not stored. Isolated browser tests raise the admin read limiter to **2000**, the mutation limiter to **100**, and the financial limiter to **50**; production remains 120 reads, 20 mutations, and 5 financial/recovery actions per principal per 60s.

Analytics charts remain Phase 9. The approved customer landing page and artwork are unchanged.
