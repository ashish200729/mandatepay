# Admin Phase 2 — audit foundation

Completed and verified locally on 2026-10-05 after the [Phase 1 security foundation](./ADMIN_PHASE_1.md). All 14 tasks and three exit criteria are checked in [the admin plan](../../MandatePay_Admin_Implementation_Plan.md). The [API contract](../architecture/admin-api.md) now distinguishes implemented identity/audit endpoints from planned operational controls.

## Checklist evidence

| Tasks    | Implementation and evidence                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2-01–02 | Separate `AdminAuditEvent` preserves the existing customer/domain audit model. Additive migration `20261005000100_add_admin_audit` creates audit enums, event storage, durable action requests, indexes, constraints and UPDATE/DELETE/TRUNCATE protection. Applied to local development and isolated test databases; 15 migrations total. |
| P2-03    | `AdminAuditRepository` exposes append, findById and bounded list only. A transaction client lets domain changes and audit append commit or roll back together. PostgreSQL triggers also reject raw SQL history changes.                                                                                                                    |
| P2-04–05 | Shared and Prisma closed action, target, result and error enums. Action-to-target validation, complete historical actor snapshots, and coherent success/failure results are enforced before app writes and DTO reads.                                                                                                                      |
| P2-06    | Target-specific scalar summary builders discard unknown fields and nested data. Both repository reads and the admin BFF project safe DTOs again.                                                                                                                                                                                           |
| P2-07    | Shared `requireAdminReason` and repository input validation require trimmed 1–255 character reasons; control characters and recognizable credential material are rejected without echoing input.                                                                                                                                           |
| P2-08    | Server-generated UUID request IDs, validated UUID correlation headers, response trace headers, immutable action IDs and filter-bound signed cursors. An action outcome cannot switch its original correlation ID.                                                                                                                          |
| P2-09    | Credential login and reauthentication success/failure are recorded safely; successful proof creation/rotation and logout revocation append in the same transaction. Failed credentials never persist the supplied email/password or raw Better Auth response.                                                                              |
| P2-10–12 | Authorized GET `/api/admin/audit` and `/api/admin/audit/:id`; strict action, target, actor, result, correlation and UTC date filters; stable cursor pagination. Allowlisted admin BFF forwards these reads only.                                                                                                                           |
| P2-13–14 | Real PostgreSQL/API tests reject edit/delete/truncate and public write routes, verify transaction rollback, concurrent idempotent intent claims, immutable outcomes, signed cursor tampering, trace spoofing, and safe stored/API/BFF projections.                                                                                         |

## Storage and append rules

`AdminAuditEvent` records UUID event ID; nullable actor principal/user/role snapshots; closed action and target type; bounded target ID and reason; request/correlation/action IDs; safe before/after summaries; result and optional normalized error code; creation time. Actor and target identifiers deliberately have no cascading identity FKs: removing a live identity must not remove or rewrite immutable historical facts. Anonymous events are limited to login/reauth failures with all actor fields null. Auth events never infer identity from a submitted email. Auth success requires a verified, active singleton principal from the database.

The repository validates action/target coherence and auth action/result coherence. SUCCESS has no error code; FAILURE requires a closed error code. PostgreSQL independently checks actor completeness, nonblank bounded reason, result/error coherence and object-or-null summaries. Its triggers reject UPDATE, DELETE and TRUNCATE. No application endpoint accepts arbitrary audit inserts or permits edits/deletes. Database administration/DDL is outside this app API guarantee.

Action names are normalized and reserved for implemented or future adapters:

- `ADMIN_LOGIN_SUCCEEDED`, `ADMIN_LOGIN_FAILED`, `ADMIN_REAUTH_SUCCEEDED`, `ADMIN_REAUTH_FAILED`, `ADMIN_LOGOUT_SUCCEEDED`.
- `ADMIN_USER_DISABLED`, `ADMIN_USER_ENABLED`, `ADMIN_SESSIONS_REVOKED`, `ADMIN_AUTONOMY_DISABLED`, `ADMIN_NOTE_ADDED`.
- `ADMIN_MANDATE_PAUSED`, `ADMIN_MANDATE_REVOKED`, `ADMIN_PAYMENT_RECONCILE_REQUESTED`, `ADMIN_REFUND_REQUESTED`.
- `ADMIN_WEBHOOK_RETRY_REQUESTED`, `ADMIN_WEBHOOK_RECONCILE_REQUESTED`, `ADMIN_FEATURE_FLAG_CHANGED`, `ADMIN_MAINTENANCE_MODE_CHANGED`.

Operational names do not enable those controls. New action semantics must extend the closed enums and their action-to-target mapping through a reviewed additive migration before an endpoint is introduced.

## Redaction and reasons

Allowed summary facts are target-specific: auth has no fields; sessions expose expiry/freshness/revocation; users verification/autonomy/disable date; mandates status/version/currency; proposal/payment/refund status/amountMinor/currency/sample flag; approvals decision/expiry; webhooks stored status/verification/attempt count/next retry; platform settings an approved boolean key/value/version; system a closed health status. Status enums match existing persisted state machines, including refund CANCELLED. Monetary values are safe nonnegative integer minor units in USD. Dates are UTC ISO strings.

There is no free-form payload/error-message field. Unknown nested records, credentials, cookies, tokens, provider requests/responses, prompts, emails, IP addresses and user agents are dropped from summaries. Existing opaque IDs are bounded; setting targets use the approved key registry. The request fingerprint stays server-side and out of audit DTOs. Login reasons are fixed server text.

Operator reasons reject recognizable named credential assignments, bearer values, JWTs, private-key material, known API-key prefixes, credential/query URLs and long opaque strings. This is not a perfect classifier for arbitrary secrets disguised as ordinary prose. Future controls must collect a human explanation, never copy request bodies, provider errors or credentials into reasons; use the summary builder for before/after state. Tests establish exclusion of known credential fields and patterns, not universal inference about arbitrary text.

## Search and trace contract

GET `/api/admin/audit` accepts only `action`, `targetType`, `targetId`, `result`, `actorAdminId`, `correlationId`, `from`, `to`, `limit` and `cursor`. A target ID requires its type. Date bounds must be supplied together as UTC ISO timestamps, use `[from,to)`, and span at most 366 days. Limit is 1–100, default 50. No free-text search, arbitrary sort, offset or export endpoint is implemented. Detail IDs must be UUIDs; invalid input is 400 and unknown events are 404.

Ordering is creation time descending, then ID descending. The opaque HMAC-SHA256 cursor binds its boundary to every normalized filter and page limit. Altered cursors or filters return 400; signing uses the existing server-only Better Auth secret. Secret rotation invalidates old cursors safely. DTOs and trace headers use private/no-store responses and require the same Phase 1 authorization/read bucket as `/me`.

The API generates each request ID as a UUID and ignores caller request IDs. An optional `x-correlation-id` must be a UUID; absent values default to that request ID. The BFF generates correlation IDs when absent, forwards only the validated trace value, and returns only UUID-valued upstream trace headers. API audit envelopes include both IDs; the BFF includes the request ID and returns the correlation header. Correlation is trace metadata, never authorization or an idempotency key.

Credential failures are logged durably only after trusted-origin/content-type and attempt limits admit the request. Rejected preflight, malformed transport, unauthorized reauth and rate-limited requests rejected before the credential handler remain bounded safe request/security logs, rather than allowing unauthenticated audit write amplification. Successful credential verification appends alongside the session proof; an audit failure prevents the grant and removes the newly created Better Auth session. Reauth preserves the previous session when that transaction fails. Logout revocation rolls back if its audit append fails.

## Contract for future mutations

`AdminActionRepository` supplies durable intent/outcome identity; it does not execute or authorize business actions. Claims validate the active verified principal and UUID request key, serialize concurrent `(principalId,requestKey)` submissions, and compare canonical SHA256 fingerprints of normalized action/target/reason/before/requested summary. The claim and PENDING audit append commit together. Same input returns the same action ID; changed input conflicts. The intent's requested state never masquerades as an observed after-state.

Outcome recording locks the action, checks actor ownership and the original correlation ID, and commits status/result summary with a new immutable audit event. Unknown provider results remain PENDING. An identical terminal result is a no-op; a different terminal result conflicts. Immutable audit snapshots remain separate from the mutable orchestration row.

Future local mutations must recheck authorization/freshness and expected state under domain locks, use the transaction-aware `claimInTransaction`/`recordOutcomeInTransaction` or `AdminAuditRepository(tx).append`, and commit the actual state change and success audit atomically. A rejected action may append FAILURE in a separate transaction after the domain transaction rolls back. Existing services that own transactions need explicit adapters; wrapping them in an unrelated transaction does not establish atomicity.

Provider operations must commit intent before calling the provider, retain the existing financial idempotency key, and record only verified success, safe rejection, or pending uncertainty afterwards. An intent audit is never proof of completed money movement. All domain lock ordering and financial state rules in the Phase 0 contract continue to apply.

## Verification and local limits

- 332 repository unit tests pass, including four shared audit contract/redaction tests and two admin audit/BFF tests.
- 13 environment and server-package boundary tests pass.
- 87 API integration tests and eight database integration tests pass on isolated PostgreSQL. The 16 admin API cases include Phase 1 guards plus six audit/transaction/idempotency regression cases. Financial provider regressions use simulated providers.
- Two admin Playwright tests pass against the production Next build, real API and test database, including desktop/mobile session flow and authorized audit list/detail through the BFF. Existing loading/unavailable UI cases are browser simulations. No audit page is built in Phase 2.
- Shared/database/API TypeScript builds, admin production build, browser test type check, affected ESLint, changed-file formatting, Prisma validation/migration status and frozen offline lockfile validation pass. Admin dependency/import gate passes; emitted browser assets contain no checked backend-package or secret-environment markers.

Repeat with `pnpm test`, `pnpm test:integration` and `pnpm test:e2e:admin`, plus affected lint/type/build checks. This Windows workspace's incomplete executable shims required direct installed Node CLI invocation. Principal-owning admin integration and browser fixtures must run sequentially on the same dedicated `_test` database. Their mutable fixtures are removed; immutable audit events deliberately remain in that test database and are not deleted by cleanup.

The real main administrator remains an operator-chosen existing verified identity under the Phase 1 bootstrap instructions. No real account was granted access by this phase. Local migrations are current with no admin model drift. The pre-existing WebhookInbox recovery index discrepancy remains unchanged and its database index is preserved. The unrelated 281-file formatting baseline is unchanged. Operational UI, domain controls, hosted deployment and live financial/provider qualification retain their later gates.
