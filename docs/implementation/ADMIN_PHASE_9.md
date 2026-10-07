# Admin Phase 9 — Dashboard analytics and operational reporting

Completed and verified locally on 2026-10-07 after [system health and agent observability](./ADMIN_PHASE_8.md). All 15 tasks and four exits are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). The operations overview is a ranged, server-aggregated dashboard: charts never load unbounded browser datasets, every metric has a stored definition, and each series links to a filtered list. [admin-api.md](../architecture/admin-api.md) and [admin-ui.md](../architecture/admin-ui.md) record the analytics contract.

## Checklist evidence

| Tasks | Implementation and evidence                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P9-01 | Overview and agent pages share a UTC time-range selector. Presets are last 7/30/90/365 days relative to the API `asOf`; custom From/Through dates become a half-open UTC interval of at most 366 days. The default remains 30 days when the URL has no `from`/`to`. |
| P9-02 | `newUsersByDay` is User.createdAt in range, filled to UTC day buckets, and rendered as a column chart.                                                                                                                                                              |
| P9-03 | `capturedGrossByDay` sums original captured amounts by UTC `capturedAt`. Refunds do not reduce gross.                                                                                                                                                               |
| P9-04 | `refundsByDay` sums completed non-sample refunds by UTC `settledAt`. List drill-down uses `dateBasis=settled`.                                                                                                                                                      |
| P9-05 | `policyDistribution` remains one latest AgentGuard decision per non-sample proposal created in range.                                                                                                                                                               |
| P9-06 | `approvalFunnel` is a proposal-created cohort labelled with current approval outcomes. Intermediate conversion times are not stored.                                                                                                                                |
| P9-07 | `checkoutFunnel` is the same cohort labelled with current linked order/capture/failure outcomes. `CAPTURE_PENDING` is omitted.                                                                                                                                      |
| P9-08 | Webhook health is delivery attempts by UTC day, delivery outcomes in range, and current verified inbox status counts.                                                                                                                                               |
| P9-09 | `topErrorCategories` is the top 12 closed PAY/REF/WEBHOOK/AGENT classes in range. Raw provider messages are not returned.                                                                                                                                           |
| P9-10 | `mandateStatusDistribution` is stored status counts plus a separately labelled effectively-expired count.                                                                                                                                                           |
| P9-11 | Overview shows agent runs by day and failed-run error classes. `/agent` accepts the same UTC range.                                                                                                                                                                 |
| P9-12 | Each chart has a “View records” link; categorical bars and day columns link to the matching filtered list. Approval current-outcome stages use `/approvals?decision=` because that list is not a proposal-created cohort.                                           |
| P9-13 | `ADMIN_METRIC_DEFINITIONS` is the single source of definition strings. Integration tests require every overview metric definition to match.                                                                                                                         |
| P9-14 | Overview with the selected range completes in under five seconds in the isolated test database. Series length is capped at 400. `EXPLAIN` of captured volume is an aggregate, not a full-row client dump.                                                           |
| P9-15 | Profiles did not require new indexes or materialized views at MVP scale. `Payment.capturedAt` and `Refund.settledAt` remain unindexed.                                                                                                                              |

All four exits are satisfied: definitions are explicit, charts link to records, aggregates stay within the MVP budget, and the browser only receives bounded series.

## Verification

- **364 repository unit tests** pass, including metric-definition, UTC bucket, error-category, drill-down href, and overview query-bound tests.
- **13 environment/boundary tests** pass. Admin source still excludes server packages.
- **21 admin API integration tests** pass, including definition equality, funnel/capture series, settled-date refund drill-down, a 5s overview budget, and an aggregate `EXPLAIN` of captured volume.
- **Eleven admin browser tests** pass against a production Next build, the real API, and the isolated PostgreSQL test database. The new test covers the time-range selector, charts at 390px and 1280px, Last 7 days, and User growth → `/users?from=`.
- Production API and admin builds pass. No schema migration was added.

Repeat the meaningful checks from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node --test scripts/environment.test.mjs scripts/check-admin-boundaries.test.mjs
node scripts/check-admin-boundaries.mjs
pnpm --filter @mandatepay/api test:integration
pnpm test:e2e:admin
```

Windows executable shims in this workspace are incomplete, so installed CLIs are invoked directly with Node where needed. The browser command expects a current production build of `@mandatepay/api` and `@mandatepay/admin`.

## Remaining boundaries

No real administrator was provisioned, and no hosting or new live-provider qualification is claimed. Dashboard fixtures in browser tests are the existing isolated admin principal plus synthetic operations rows. Isolated browser tests raise the admin read limiter to **2000**, the mutation limiter to **100**, and the financial limiter to **50**; production remains 120/20/5. Historical intermediate-state conversion times remain unavailable. Provider health history is still not stored. Phase 10 hardening remains unchecked.
