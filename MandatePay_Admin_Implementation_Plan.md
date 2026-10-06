# MandatePay Admin Panel — Implementation Plan

> **Target:** `apps/admin`  
> **Scope:** One main administrator for the initial release  
> **Architecture rule:** Admin capabilities must never bypass MandatePay's existing authorization, AgentGuard, spending, PayPal Sandbox, refund, webhook, or audit invariants.

---

## 1. Objective

Build a production-quality administrative application for MandatePay that gives the main administrator a safe, complete operational view of the platform and controlled mechanisms to manage users, mandates, proposals, approvals, orders, payments, refunds, webhooks, AI activity, configuration, and system health.

The admin application should have:

- A polished, responsive admin UI/UX.
- One authenticated main administrator.
- Dedicated admin authorization.
- Platform overview and operational dashboards.
- User/account management.
- Mandate and proposal inspection.
- Approval, payment, order, and refund visibility.
- Safe operational controls.
- PayPal Sandbox and webhook diagnostics.
- AI/agent usage visibility.
- System health and worker monitoring.
- Feature/configuration controls.
- Immutable admin action logs.
- Search, filters, pagination, drill-down pages, and exports where useful.
- Strong protections for destructive or financial actions.
- No exposure of passwords, auth tokens, secrets, raw provider credentials, or unsafe provider payloads.

---

# 2. Core Principles

## 2.1 Admin is not a bypass layer

The admin app must not call Prisma directly and must not mutate business tables from the browser.

All data access should flow:

```text
apps/admin
    ↓
apps/api /api/admin/*
    ↓
admin authorization middleware
    ↓
service/repository layer
    ↓
existing MandatePay domain invariants
    ↓
PostgreSQL / PayPal Sandbox / worker systems
```

Admin actions involving money or policy must reuse existing domain services wherever possible.

Examples:

- An admin must not manually mark a PayPal payment as captured.
- An admin must not force an AgentGuard `BLOCK` into `ALLOW`.
- An admin must not fabricate a refund success state.
- An admin may request reconciliation, retry processing, pause a user capability, revoke sessions, or disable a platform feature through controlled service operations.

---

## 2.2 Read-only by default

Most screens should be operationally read-only.

Mutating actions should be visually separated and require:

1. Authorization check.
2. Current-state validation.
3. Reason/comment.
4. Confirmation.
5. Reauthentication for high-risk actions.
6. Idempotency key where relevant.
7. Transactional mutation.
8. Immutable admin audit event.
9. Updated state returned to the UI.

---

## 2.3 One main admin now, extensible later

Initial release:

```text
ADMIN_SUPER
```

Only one account is allowed to access `apps/admin`.

Do not build full RBAC management yet, but structure the authorization layer so roles can later become:

```text
ADMIN_SUPER
ADMIN_SUPPORT
ADMIN_FINANCE
ADMIN_OPERATIONS
ADMIN_READONLY
```

---

# 3. Recommended Monorepo Placement

```text
apps/
├── web/
├── api/
└── admin/
    ├── app/
    │   ├── (auth)/
    │   ├── (admin)/
    │   ├── login/
    │   ├── users/
    │   ├── mandates/
    │   ├── proposals/
    │   ├── approvals/
    │   ├── orders/
    │   ├── payments/
    │   ├── refunds/
    │   ├── webhooks/
    │   ├── agent/
    │   ├── audit/
    │   ├── system/
    │   └── settings/
    ├── components/
    ├── lib/
    ├── hooks/
    ├── styles/
    ├── middleware.ts
    └── package.json
```

Shared code should continue to come from packages such as:

```text
@mandatepay/shared
@mandatepay/ui
@mandatepay/database       # API/server only
@mandatepay/agentguard     # API/server only
@mandatepay/paypal         # API/server only
```

`apps/admin` must never import server-only database/payment packages into client bundles.

---

# 4. Proposed Admin Information Architecture

## Main navigation

```text
Overview

Operations
├── Users
├── Mandates
├── Proposals
├── Approvals
├── Orders
├── Payments
└── Refunds

Platform
├── Agent Activity
├── Webhooks
├── Audit Logs
├── System Health
└── Configuration

Admin
└── My Session
```

---

# 5. Admin Screens

## 5.1 Overview Dashboard — `/`

Purpose: a single operational snapshot.

### KPI cards

- Total users
- Verified users
- Active mandates
- Active proposals
- Approval-required proposals
- Orders created
- Captured payments
- Payment failures
- Refund total
- Webhook failures
- Recovery queue depth
- Agent requests
- Autonomous purchasing enabled users

### Operational widgets

- Payments by day.
- Refunds by day.
- Proposal policy outcomes:
  - ALLOW
  - REQUIRE_APPROVAL
  - BLOCK
- Recent high-risk admin/system events.
- Webhook processing health.
- Failed/recovering payments.
- Recent user registrations.
- Current platform control state.

### Quick links

- Failed payments
- Pending approvals
- Webhook failures
- Recent refunds
- System controls
- Full admin audit

---

## 5.2 Users — `/users`

### List

Columns:

- User ID
- Name/email
- Email verified
- Account status
- Autonomous purchasing setting
- Active mandates
- Proposal count
- Captured spend
- Last activity
- Created date

### Filters

- Email/name
- Verified/unverified
- Enabled/disabled
- Autonomous purchasing on/off
- Created date
- Last activity
- Has active mandate

### User detail — `/users/[id]`

Tabs:

1. Overview
2. Mandates
3. Proposals
4. Orders
5. Payments
6. Refunds
7. Audit
8. Sessions
9. Admin notes / history

### Allowed admin controls

- Disable/enable account.
- Revoke active sessions.
- Require fresh sign-in.
- Disable autonomous purchasing for the user.
- View verification status.
- Trigger supported verification flow only if existing auth architecture permits it safely.
- Add internal admin note.
- Open related mandates/orders/payments.

### Forbidden controls

- View password.
- Set/read raw password.
- Read session tokens.
- Read auth secrets.
- Arbitrarily edit captured payment state.
- Turn a blocked proposal into an allowed one.
- Impersonate users in v1.

---

## 5.3 Mandates — `/mandates`

### List

- Mandate ID
- Owner
- Status
- Version
- Limits
- Merchant/category constraints
- Validity dates
- Created/updated date

### Detail

- Canonical mandate JSON rendered safely.
- Human-readable policy summary.
- Version history.
- Related proposals.
- Related policy events.
- Related spend reservations.
- Audit timeline.

### Admin controls

Keep limited in v1:

- Inspect.
- Pause/revoke only through existing lifecycle service if platform policy explicitly allows admin intervention.
- Add reason.
- Never silently edit a user's active mandate.

Preferred behavior for an emergency admin action:

```text
Admin suspend
    ↓
existing mandate transition service
    ↓
audit user-facing system event
    ↓
admin audit event
```

---

## 5.4 Proposals — `/proposals`

### List

- Proposal ID
- User
- Product
- Amount
- Mandate
- Policy decision
- Current state
- Checkout eligibility
- Created date
- Expiry/deadline

### Detail

- Product snapshot.
- Price.
- Mandate version.
- AgentGuard decision.
- Reason codes.
- Spend reservation.
- Approval history.
- Payment/order link.
- Full audit timeline.

### Controls

- Re-evaluate through current AgentGuard service.
- Expire/cancel when domain rules permit.
- No manual "force allow."

---

## 5.5 Approvals — `/approvals`

Admin view should show:

- Pending approvals.
- Expired approvals.
- Approved/rejected history.
- Owner.
- Proposal.
- Deadline.
- Decision timestamp.

Admin should normally not approve a user's purchase on the user's behalf.

If emergency support override is ever added later, it must be a separately designed audited capability and not part of v1.

---

## 5.6 Orders — `/orders`

### List

- Internal order ID
- User
- Proposal
- PayPal order ID
- Amount
- State
- Approval state
- Capture state
- Created date

### Detail

- Internal order state.
- PayPal identifiers.
- Reconciliation status.
- Payment record.
- Refunds.
- Audit timeline.

### Admin controls

- Request reconcile.
- Retry safe internal recovery job.
- View normalized provider result.

Do not expose raw access tokens or unnecessary provider payloads.

---

## 5.7 Payments — `/payments`

### List

- Payment ID
- User
- Order
- Amount
- PayPal capture ID
- Status
- Reconcile status
- Refund status
- Timestamp

### Filters

- Status
- Amount range
- Date range
- User
- Capture ID
- Reconcile state
- Refund state

### Detail

- Payment facts.
- Proposal.
- Order.
- Capture result.
- Refund history.
- Reconciliation history.
- Audit events.

### Safe controls

- Reconcile against PayPal Sandbox.
- Retry a failed idempotent reconciliation operation.
- Freeze further platform actions for suspicious cases if a supported account-control mechanism exists.

Never:

- Edit amount.
- Change capture ID.
- Mark success manually.
- Delete a payment record.

---

## 5.8 Refunds — `/refunds`

### List

- Refund ID
- User
- Payment
- Amount
- Type
- Status
- Provider refund ID
- Created date

### Detail

- Original payment.
- Refund amount.
- Refund guard decision.
- Stable key.
- Invoice binding.
- Provider status.
- Audit history.

### Controls

- Refresh/refetch status.
- Retry supported reconciliation.
- Create refund only by invoking the existing guarded refund workflow.
- Require explicit reason and confirmation.

The existing rule remains:

> Refunds do not restore gross spending permission.

---

## 5.9 Webhooks — `/webhooks`

### Dashboard

- Received
- Verified
- Rejected
- Deduplicated
- Processing
- Completed
- Failed
- Retrying
- Dead/terminal, if such a state exists

### Inbox table

- Event ID
- Provider event type
- Verification state
- Processing state
- Attempt count
- Lease state
- Received date
- Processed date
- Last error summary

### Detail

Show only safe normalized fields.

Do not display sensitive raw payloads by default.

### Controls

- Retry processing.
- Release/recover stale lease through a safe service.
- Reconcile linked order/payment.
- Mark terminal only through explicit controlled logic.

---

## 5.10 Agent Activity — `/agent`

Purpose: operational visibility into AI usage without exposing sensitive prompt data unnecessarily.

### Metrics

- Chat requests
- Successful runs
- Tool calls
- Failed runs
- Average latency
- Proposal creation count
- Refund-draft preparation count
- Tool error rate

### Per-run detail

Store/display safe operational metadata:

- Request/run ID
- User ID
- Timestamp
- Selected tool names
- Duration
- Outcome
- Error classification
- Proposal/refund draft IDs

Avoid retaining unnecessary full raw prompts or model chain-of-thought.

If user message retention is required, define a separate privacy policy before storing it.

---

## 5.11 Audit Logs — `/audit`

This is the administrative source of truth for privileged actions.

### Events should include

- Event ID
- Timestamp
- Admin actor ID
- Admin role
- Action
- Target type
- Target ID
- Reason
- Before-state summary
- After-state summary
- Request ID
- IP hash / safe network metadata if policy allows
- User agent summary
- Correlation ID
- Success/failure
- Error code

### Examples

```text
ADMIN_USER_DISABLED
ADMIN_USER_ENABLED
ADMIN_SESSIONS_REVOKED
ADMIN_AUTONOMY_DISABLED
ADMIN_MANDATE_PAUSED
ADMIN_PAYMENT_RECONCILE_REQUESTED
ADMIN_REFUND_REQUESTED
ADMIN_WEBHOOK_RETRY_REQUESTED
ADMIN_FEATURE_FLAG_CHANGED
ADMIN_MAINTENANCE_MODE_CHANGED
ADMIN_LOGIN_SUCCEEDED
ADMIN_LOGIN_FAILED
ADMIN_REAUTH_SUCCEEDED
```

Admin audit records should be append-only.

---

## 5.12 System Health — `/system`

### Services

- API readiness
- PostgreSQL connectivity
- PayPal Sandbox connectivity/status
- Webhook worker heartbeat
- Webhook backlog
- Recovery backlog
- Agent/provider health
- Channel3 discovery health
- Demo Catalog availability

### Runtime diagnostics

- API version / commit SHA
- Environment
- Last worker heartbeat
- Last successful PayPal reconcile
- Last webhook processed
- Pending failed jobs

Do not expose secrets or full environment variables.

---

## 5.13 Platform Configuration — `/settings/platform`

Recommended controls:

### Financial safety

- Global autonomous purchasing kill switch.
- New PayPal checkout enable/disable.
- Refund initiation enable/disable.
- Approval processing enable/disable, only if a valid operational use case exists.

### AI/discovery

- Shopping agent enable/disable.
- Proposal creation from agent enable/disable.
- Demo Catalog enable/disable.
- Channel3 discovery enable/disable.

### Operations

- Maintenance mode.
- Worker processing enable/disable if supported safely.
- Registration enable/disable.
- Optional read-only mode.

### Rules

All settings:

- Stored server-side.
- Validated with schemas.
- Versioned.
- Cached safely if needed.
- Audited.
- Require a reason for change.
- Sensitive controls require reauthentication.
- UI displays who changed them and when.

---

# 6. UI/UX Specification

## 6.1 Design direction

The admin app should visually relate to the existing MandatePay workspace but be clearly distinguishable as an administrative environment.

Recommended layout:

```text
┌──────────────────────────────────────────────────────┐
│ Top bar: MandatePay Admin | Environment | Admin     │
├───────────────┬──────────────────────────────────────┤
│ Sidebar       │ Page title                           │
│               │ Breadcrumbs                          │
│ Overview      │ Filters / actions                    │
│ Users         │                                      │
│ Mandates      │ Data / charts / cards                │
│ Proposals     │                                      │
│ Orders        │                                      │
│ Payments      │                                      │
│ Refunds       │                                      │
│ Webhooks      │                                      │
│ Agent         │                                      │
│ Audit         │                                      │
│ System        │                                      │
│ Settings      │                                      │
└───────────────┴──────────────────────────────────────┘
```

---

## 6.2 Shared UI components

Create/reuse:

- `AdminShell`
- `AdminSidebar`
- `AdminTopbar`
- `PageHeader`
- `Breadcrumbs`
- `MetricCard`
- `StatusBadge`
- `DataTable`
- `FilterBar`
- `DateRangeFilter`
- `SearchInput`
- `Pagination`
- `EmptyState`
- `ErrorState`
- `LoadingSkeleton`
- `ConfirmDialog`
- `DangerConfirmDialog`
- `ReasonDialog`
- `ReauthDialog`
- `EntityLink`
- `JsonViewer`
- `AuditTimeline`
- `EventTimeline`
- `HealthIndicator`
- `FeatureToggleCard`

Use `@mandatepay/ui` where possible and extend it instead of duplicating basic primitives.

---

## 6.3 Data table standards

Every major table should support where applicable:

- Server-side pagination.
- Sorting.
- Search.
- Status filters.
- Date filters.
- Clear-filter control.
- Loading state.
- Empty state.
- Error/retry state.
- Click-through rows.
- Column visibility only if useful.
- CSV export for non-sensitive operational data.
- URL-synchronized filters.

Example:

```text
/payments?status=FAILED&from=2026-10-01&to=2026-10-05&page=2
```

This allows bookmarked operational views.

---

## 6.4 UX for destructive/sensitive actions

Use three levels.

### Low risk

Example:

- Refresh provider status.

Confirmation may not be required.

### Medium risk

Example:

- Retry webhook.
- Revoke sessions.

Require:

- confirmation
- reason

### High risk

Example:

- disable account
- global checkout off
- global autonomy off
- initiate refund
- pause/revoke mandate administratively

Require:

- fresh admin authentication
- typed confirmation
- reason
- final review dialog

---

# 7. Authentication and Authorization Design

## Admin identity source

Reuse the existing Better Auth user/session system, then layer admin authorization on top.

Recommended database model:

```prisma
model AdminPrincipal {
  id        String   @id @default(cuid())
  userId    String   @unique
  role      AdminRole @default(ADMIN_SUPER)
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum AdminRole {
  ADMIN_SUPER
}
```

Alternative for the very first bootstrap:

```env
MANDATEPAY_ADMIN_USER_ID=...
```

But the database-backed `AdminPrincipal` model is preferred because it is auditable and easier to extend.

The environment variable can be used only by a bootstrap/seed command that creates the first `AdminPrincipal`.

---

## Required admin middleware

```text
authenticateSession
    ↓
requireVerifiedAccount
    ↓
requireAdminPrincipal
    ↓
requireActiveAdmin
    ↓
optional requireFreshAdminAuth
    ↓
route handler
```

Suggested server helpers:

```ts
requireAdmin(request)
requireSuperAdmin(request)
requireFreshAdminAuth(request)
assertAdminActionAllowed(...)
writeAdminAudit(...)
```

---

## Admin session security

Recommended:

- Secure, HTTP-only cookies.
- SameSite policy appropriate for actual deployment topology.
- Trusted-origin enforcement.
- Separate admin rate limits.
- Session idle timeout.
- Fresh-auth timestamp for sensitive operations.
- Revoke sessions from admin profile.
- No auth/session tokens in logs.
- Log failed admin access attempts safely.
- Optional TOTP/passkey in a later hardening phase if not already available.

---

# 8. API Design

All admin APIs live below:

```text
/api/admin/*
```

Never overload the regular user endpoints with hidden `?admin=true` behavior.

---

## 8.1 Overview

```http
GET /api/admin/overview
GET /api/admin/overview/activity
```

---

## 8.2 Users

```http
GET  /api/admin/users
GET  /api/admin/users/:userId
GET  /api/admin/users/:userId/sessions
POST /api/admin/users/:userId/disable
POST /api/admin/users/:userId/enable
POST /api/admin/users/:userId/revoke-sessions
POST /api/admin/users/:userId/disable-autonomy
POST /api/admin/users/:userId/notes
```

---

## 8.3 Mandates

```http
GET  /api/admin/mandates
GET  /api/admin/mandates/:mandateId
POST /api/admin/mandates/:mandateId/pause
POST /api/admin/mandates/:mandateId/revoke
```

Administrative lifecycle actions should be included only after confirming they map correctly to current mandate state-machine rules.

---

## 8.4 Proposals / approvals

```http
GET  /api/admin/proposals
GET  /api/admin/proposals/:proposalId
POST /api/admin/proposals/:proposalId/re-evaluate

GET  /api/admin/approvals
GET  /api/admin/approvals/:approvalId
```

---

## 8.5 Orders / payments

```http
GET  /api/admin/orders
GET  /api/admin/orders/:orderId
POST /api/admin/orders/:orderId/reconcile

GET  /api/admin/payments
GET  /api/admin/payments/:paymentId
POST /api/admin/payments/:paymentId/reconcile
```

---

## 8.6 Refunds

```http
GET  /api/admin/refunds
GET  /api/admin/refunds/:refundId
POST /api/admin/refunds/:refundId/refresh
POST /api/admin/payments/:paymentId/refund
```

The refund POST should call the existing guarded refund service rather than duplicate refund logic.

---

## 8.7 Webhooks

```http
GET  /api/admin/webhooks
GET  /api/admin/webhooks/:eventId
POST /api/admin/webhooks/:eventId/retry
POST /api/admin/webhooks/:eventId/reconcile
```

---

## 8.8 Agent

```http
GET /api/admin/agent/runs
GET /api/admin/agent/runs/:runId
GET /api/admin/agent/metrics
```

---

## 8.9 Audit

```http
GET /api/admin/audit
GET /api/admin/audit/:eventId
```

No delete/update endpoint.

---

## 8.10 System

```http
GET  /api/admin/system/health
GET  /api/admin/system/workers
GET  /api/admin/system/integrations
```

---

## 8.11 Configuration

```http
GET   /api/admin/settings
PATCH /api/admin/settings/:key
```

Each PATCH request:

```json
{
  "value": "...",
  "reason": "..."
}
```

Sensitive changes should also require a short-lived fresh-auth proof.

---

# 9. Database / Repository Changes

Prefer additions inside `@mandatepay/database`.

Potential models:

```text
AdminPrincipal
AdminAuditEvent
PlatformSetting
AdminNote
WorkerHeartbeat
AgentRunMetric        # only if current telemetry does not already exist
```

Do not duplicate data that can be queried reliably from existing models.

---

## 9.1 `AdminAuditEvent`

Suggested fields:

```text
id
actorAdminId
actorUserId
role
action
targetType
targetId
reason
requestId
correlationId
beforeSummaryJson
afterSummaryJson
result
errorCode
networkMetadataJson
createdAt
```

Rules:

- Append-only.
- No application update/delete operations.
- Safe summaries only.
- No tokens.
- No passwords.
- No PayPal secrets.
- No raw OAuth responses.
- Avoid raw provider payloads.

---

## 9.2 `PlatformSetting`

Suggested fields:

```text
key
valueJson
version
updatedByAdminId
updatedAt
```

Optional history can be derived from `AdminAuditEvent`, but a versioned setting history table may be added if rollback becomes important.

Suggested keys:

```text
platform.maintenanceMode
platform.registrationEnabled
agent.enabled
agent.proposalCreationEnabled
discovery.demoCatalogEnabled
discovery.channel3Enabled
payments.checkoutEnabled
payments.refundsEnabled
payments.autonomyEnabledGlobally
workers.webhookProcessingEnabled
```

Use schema validation for every key.

---

# 10. Logging and Observability

Use three separate concepts.

## Application logs

For debugging/runtime operations.

Must use structured logs with:

```text
timestamp
level
service
requestId
route
duration
result
errorCode
```

Redact:

- Authorization headers.
- Cookies.
- Better Auth tokens.
- PayPal access tokens.
- Password/reset tokens.
- Full webhook secrets.
- Sensitive personal data beyond what operations require.

---

## Domain audit events

Existing customer/product audit timeline.

Examples:

- mandate activated
- proposal evaluated
- payment captured
- refund submitted

---

## Admin audit events

Privileged administrator actions.

Examples:

- user disabled
- sessions revoked
- webhook retry requested
- checkout kill switch changed

Do not rely on application logs as the audit trail.

---

# 11. Operational Controls

## Global kill switches

Build server-enforced controls, not UI-only switches.

### `payments.autonomyEnabledGlobally`

If false:

```text
autonomous execution → denied
manual approval path may remain available
```

### `payments.checkoutEnabled`

If false:

```text
new PayPal order creation → denied
existing reconciliation/webhooks → continue
```

### `payments.refundsEnabled`

If false:

```text
new refund initiation → denied
refund status reconciliation → continue
```

### `agent.enabled`

If false:

```text
POST /api/agent/chat → controlled unavailable response
```

### `discovery.channel3Enabled`

If false:

```text
external Channel3 discovery calls → disabled
Demo Catalog may remain available
```

### `platform.maintenanceMode`

Recommended behavior:

- Public health checks remain available.
- Admin remains available.
- User financial mutations are blocked.
- Webhook ingestion/recovery can remain active unless explicitly disabled.

This separation is important to avoid losing provider events during maintenance.

---

# 12. Error Handling Standard

Every admin API error should return a safe structured form:

```json
{
  "error": {
    "code": "ADMIN_ACTION_NOT_ALLOWED",
    "message": "This action is not allowed in the current state.",
    "requestId": "..."
  }
}
```

Do not expose stack traces in production responses.

Recommended admin-specific codes:

```text
ADMIN_UNAUTHORIZED
ADMIN_FORBIDDEN
ADMIN_REAUTH_REQUIRED
ADMIN_ACTION_NOT_ALLOWED
ADMIN_REASON_REQUIRED
ADMIN_CONFIRMATION_REQUIRED
ADMIN_STATE_CONFLICT
ADMIN_RATE_LIMITED
ADMIN_SETTING_INVALID
ADMIN_TARGET_NOT_FOUND
ADMIN_RECONCILE_FAILED
ADMIN_RETRY_NOT_ALLOWED
```

---

# 13. Security Requirements

Mandatory before considering the admin panel complete:

- [ ] Every `/api/admin/*` route requires admin auth.
- [ ] The browser never gets database credentials.
- [ ] The browser never gets PayPal secret/client secret.
- [ ] No admin operation bypasses AgentGuard.
- [ ] No admin operation manually sets provider success states.
- [ ] No raw auth tokens are logged.
- [ ] CSRF/trusted-origin protections cover admin mutations.
- [ ] Sensitive mutations require reauthentication.
- [ ] Financial/admin mutations have rate limits.
- [ ] Every privileged mutation creates an admin audit event.
- [ ] Audit writes occur transactionally with the mutation where possible.
- [ ] State-changing endpoints are idempotent where retries are possible.
- [ ] Pagination has server-enforced upper bounds.
- [ ] Search parameters are schema validated.
- [ ] Export endpoints enforce row limits.
- [ ] Secrets are redacted from error messages.
- [ ] Admin routes have explicit test coverage for non-admin denial.
- [ ] Production build prevents accidental server-package imports into client bundles.

---

# 14. Testing Strategy

## Unit tests

- Admin authorization helpers.
- Platform setting validators.
- Admin audit event builders.
- Reauthentication checks.
- Sensitive-action policy.
- Query/filter parsing.

## Repository tests

- Owner-independent admin reads.
- Pagination.
- Filtering.
- Admin log persistence.
- Platform setting versioning.

Admin repositories may need broader visibility than owner-scoped customer repositories, so create explicit admin repository methods rather than weakening existing owner-scoped methods.

Good:

```ts
adminPaymentsRepository.list(...)
```

Bad:

```ts
paymentsRepository.list({ skipOwnerCheck: true })
```

---

## API integration tests

For every sensitive endpoint:

1. Unauthenticated → `401`
2. Authenticated non-admin → `403`
3. Admin without fresh auth where required → rejected
4. Invalid input → `400`
5. Invalid current state → `409`
6. Valid action → success
7. Audit event created
8. Retry → idempotent/safe behavior

---

## E2E tests

Recommended Playwright flows:

- Admin login.
- Non-admin rejected.
- Overview loads.
- Search user.
- Open user detail.
- Revoke sessions.
- Inspect mandate.
- Inspect blocked proposal.
- Reconcile payment.
- Retry webhook.
- Toggle safe test setting.
- Confirm audit event appears.
- Responsive navigation.
- Loading/error/empty states.

---

# 15. Phased Implementation Plan

The phases below are intentionally dependency-linked. Do not start sensitive operational controls before the security/audit foundation is complete.

---

# Phase 0 — Repository Verification and Admin Contract

**Goal:** Verify the actual implementation points that the admin app will consume.

**Depends on:** Existing MandatePay MVP.

**Completed:** 2026-10-05. See [repository verification and evidence](docs/implementation/ADMIN_PHASE_0.md) and the [admin endpoint/data contract](docs/architecture/admin-api.md). At the Phase 0 snapshot, `apps/admin` was absent and its configuration alignment was fixed for the Phase 1/3 scaffold. Phase 1 below records the subsequently implemented auth scaffold and security migration; operational routes remain later-phase work.

### TODO

- [x] **P0-01** Confirm whether `apps/admin` exists and identify its current scaffold/state (absent; scaffold belongs to Phase 1/3).
- [x] **P0-02** Confirm Next.js version/config used by `apps/web`.
- [x] **P0-03** Define admin lint, TypeScript, Tailwind/theme, and Turborepo alignment for its Phase 1/3 scaffold.
- [x] **P0-04** Inventory Better Auth session/user models and server helpers.
- [x] **P0-05** Inventory all existing Prisma models and repository methods.
- [x] **P0-06** Map current mandate state machine.
- [x] **P0-07** Map proposal/approval/payment/refund state machines.
- [x] **P0-08** Map webhook inbox/recovery worker states.
- [x] **P0-09** Confirm existing audit-event schema and whether actor type can support admin events.
- [x] **P0-10** Confirm current rate-limit implementation.
- [x] **P0-11** Confirm API trusted-origin/CORS configuration for `apps/admin`.
- [x] **P0-12** Confirm how `apps/web` calls `apps/api`.
- [x] **P0-13** Identify which admin metrics can be calculated from existing tables.
- [x] **P0-14** Produce an admin endpoint/data contract before coding pages.

### Exit criteria

- [x] No proposed admin feature depends on an unknown table/state (missing capabilities have explicit later-phase model/telemetry dependencies).
- [x] Admin-to-API authentication design is fixed.
- [x] Existing business services to reuse are documented.
- [x] Any schema migration required for Phase 1 is identified.

**Feeds into:** Phase 1.

---

# Phase 1 — Admin Security Foundation

**Goal:** Make admin identity and authorization correct before building operational pages.

**Depends on:** P0 complete.

**Completed:** 2026-10-05. See [implementation, security evidence and account bootstrap](docs/implementation/ADMIN_PHASE_1.md). Identity/session endpoints and the protected auth scaffold are implemented; operational pages and immutable admin audit remain later phases. No real account was selected or granted access automatically.

### TODO

- [x] **P1-01** Add `AdminPrincipal` model.
- [x] **P1-02** Add `AdminRole` enum with `ADMIN_SUPER`.
- [x] **P1-03** Add migration.
- [x] **P1-04** Add admin repository.
- [x] **P1-05** Add safe bootstrap/seed command for the one main admin.
- [x] **P1-06** Implement `requireAdmin`.
- [x] **P1-07** Implement `requireSuperAdmin`.
- [x] **P1-08** Implement fresh-auth tracking/check.
- [x] **P1-09** Add admin-specific rate-limit bucket.
- [x] **P1-10** Extend trusted-origin configuration for the admin app.
- [x] **P1-11** Add admin auth/session endpoint.
- [x] **P1-12** Add `GET /api/admin/me`.
- [x] **P1-13** Add admin middleware in `apps/admin` (Next.js proxy convention).
- [x] **P1-14** Build admin sign-in/access-denied/session-expired states.
- [x] **P1-15** Add security tests:
  - [x] no session
  - [x] normal user
  - [x] inactive admin
  - [x] active admin
- [x] **P1-16** Confirm server-only packages cannot enter client bundles.

### Exit criteria

- [x] Only the configured main admin can open admin routes.
- [x] Non-admin sessions cannot access admin APIs.
- [x] Sensitive endpoints can require fresh authentication.
- [x] Admin session handling is covered by tests.

**Feeds into:** Phase 2 and Phase 3.

---

# Phase 2 — Admin Audit Foundation

**Goal:** Ensure every future privileged action is traceable before adding controls.

**Depends on:** Phase 1.

### TODO

- [x] **P2-01** Decide whether to extend current audit model or add `AdminAuditEvent`.
- [x] **P2-02** Add migration if required.
- [x] **P2-03** Implement append-only admin audit repository.
- [x] **P2-04** Implement normalized action enum.
- [x] **P2-05** Implement target types.
- [x] **P2-06** Implement safe before/after summaries.
- [x] **P2-07** Add reason requirement helper.
- [x] **P2-08** Add request/correlation IDs.
- [x] **P2-09** Record admin login success/failure where safe.
- [x] **P2-10** Add `GET /api/admin/audit`.
- [x] **P2-11** Add `GET /api/admin/audit/:id`.
- [x] **P2-12** Add filtering by action, target, result, date.
- [x] **P2-13** Test immutability at repository/service level.
- [x] **P2-14** Verify redaction rules.

### Exit criteria

- [x] Every privileged admin mutation can write an audit record.
- [x] Audit data contains no credentials/secrets.
- [x] Audit events are searchable and immutable through app APIs.

Verified locally on 2026-10-05. Implementation, safe collection rules, transaction integration and test evidence: [docs/implementation/ADMIN_PHASE_2.md](docs/implementation/ADMIN_PHASE_2.md).

**Feeds into:** All mutation phases.

---

# Phase 3 — Admin UI Foundation

**Goal:** Build the complete shell and reusable operational UX.

**Depends on:** Phase 1. Can run in parallel with late Phase 2 work.

**Completed:** 2026-10-06. See [implementation and verification evidence](docs/implementation/ADMIN_PHASE_3.md) and [shared component contracts](docs/architecture/admin-ui.md). Operational destinations remain disabled until their later phases; fixture records/actions are restricted to the isolated loopback test host.

### TODO

- [x] **P3-01** Configure `apps/admin` workspace scripts.
- [x] **P3-02** Reuse `@mandatepay/ui` primitives.
- [x] **P3-03** Create admin theme tokens.
- [x] **P3-04** Build `AdminShell`.
- [x] **P3-05** Build responsive sidebar.
- [x] **P3-06** Build top bar with environment badge.
- [x] **P3-07** Build breadcrumbs.
- [x] **P3-08** Build reusable page header.
- [x] **P3-09** Build metric cards.
- [x] **P3-10** Build status badges.
- [x] **P3-11** Build server-driven table component.
- [x] **P3-12** Build search/filter/date controls.
- [x] **P3-13** Build pagination.
- [x] **P3-14** Build loading skeletons.
- [x] **P3-15** Build empty/error/retry states.
- [x] **P3-16** Build confirmation dialogs.
- [x] **P3-17** Build reason dialog.
- [x] **P3-18** Build high-risk typed-confirmation dialog.
- [x] **P3-19** Build reauthentication dialog.
- [x] **P3-20** Build audit/event timeline.
- [x] **P3-21** Add toast/notification system.
- [x] **P3-22** Make filters URL-synchronized.
- [x] **P3-23** Validate keyboard navigation and accessibility.
- [x] **P3-24** Validate tablet/mobile behavior.

### Exit criteria

- [x] All future modules can use shared admin components.
- [x] Sensitive actions have standard UX.
- [x] No page needs to invent a separate table/filter/dialog pattern.

**Feeds into:** Phases 4–9.

---

# Phase 4 — Read-Only Operations Data

**Goal:** Deliver useful administration without risky mutations first.

**Depends on:** Phases 1, 2, 3.

### Backend TODO

- [x] **P4-01** Add admin overview query service.
- [x] **P4-02** Add user list/detail admin queries.
- [x] **P4-03** Add mandate list/detail admin queries.
- [x] **P4-04** Add proposal list/detail admin queries.
- [x] **P4-05** Add approval list/detail admin queries.
- [x] **P4-06** Add order list/detail admin queries.
- [x] **P4-07** Add payment list/detail admin queries.
- [x] **P4-08** Add refund list/detail admin queries.
- [x] **P4-09** Add safe webhook list/detail queries.
- [x] **P4-10** Add cross-entity drill-down identifiers.
- [x] **P4-11** Add pagination bounds.
- [x] **P4-12** Add validated filters/sorts.
- [x] **P4-13** Add safe CSV exports where justified.

### Frontend TODO

- [x] **P4-14** Overview dashboard.
- [x] **P4-15** Users page.
- [x] **P4-16** User detail.
- [x] **P4-17** Mandates page.
- [x] **P4-18** Mandate detail.
- [x] **P4-19** Proposals page.
- [x] **P4-20** Proposal detail.
- [x] **P4-21** Approvals page.
- [x] **P4-22** Approval detail.
- [x] **P4-23** Orders page.
- [x] **P4-24** Order detail.
- [x] **P4-25** Payments page.
- [x] **P4-26** Payment detail.
- [x] **P4-27** Refunds page.
- [x] **P4-28** Refund detail.
- [x] **P4-29** Webhook inbox page.
- [x] **P4-30** Webhook detail.
- [x] **P4-31** Audit log page.
- [x] **P4-32** Audit detail.

### Exit criteria

- [x] Main admin can inspect the complete MVP flow:
  `user → mandate → proposal → approval → order → payment → refund`.
- [x] Cross-links work in both directions where useful.
- [x] Lists are paginated and filterable.
- [x] No sensitive provider/auth material is exposed.

**Feeds into:** Phase 5.

---

# Phase 5 — Safe User and Domain Controls

**Goal:** Add operational mutations that do not alter provider truth.

**Depends on:** Phases 2 and 4.

### TODO

- [ ] **P5-01** Add account disabled/suspended domain state if not already present.
- [ ] **P5-02** Enforce disabled status in normal authentication/request path.
- [ ] **P5-03** Implement admin disable user.
- [ ] **P5-04** Implement admin enable user.
- [ ] **P5-05** Implement revoke all user sessions.
- [ ] **P5-06** Implement admin disable-autonomy action.
- [ ] **P5-07** Decide whether admin may pause/revoke a mandate.
- [ ] **P5-08** If allowed, route mandate action through existing state machine.
- [ ] **P5-09** Implement proposal re-evaluation via AgentGuard.
- [ ] **P5-10** Add admin notes.
- [ ] **P5-11** Require reason for every mutation.
- [ ] **P5-12** Require fresh auth for user disable and mandate revoke.
- [ ] **P5-13** Write audit event in same transaction where practical.
- [ ] **P5-14** Add optimistic concurrency/version check.
- [ ] **P5-15** Add API integration tests.
- [ ] **P5-16** Add E2E flows.

### Exit criteria

- [ ] Admin can safely intervene in user access.
- [ ] No action bypasses existing mandate/proposal policy.
- [ ] Every action is visible in admin audit.

**Feeds into:** Phase 6.

---

# Phase 6 — Payment, Refund, and Webhook Operations

**Goal:** Add safe financial operations and recovery controls.

**Depends on:** Phase 5 and complete understanding of existing payment/recovery services.

### Payment TODO

- [ ] **P6-01** Expose payment reconciliation service to admin API.
- [ ] **P6-02** Expose order reconciliation service.
- [ ] **P6-03** Add reconcile confirmation/reason.
- [ ] **P6-04** Ensure provider truth remains authoritative.
- [ ] **P6-05** Add idempotency protection.
- [ ] **P6-06** Add audit events.

### Refund TODO

- [ ] **P6-07** Reuse existing guarded refund flow.
- [ ] **P6-08** Add admin refund initiation endpoint only if operationally needed.
- [ ] **P6-09** Require fresh auth.
- [ ] **P6-10** Require amount review.
- [ ] **P6-11** Require typed confirmation.
- [ ] **P6-12** Require reason.
- [ ] **P6-13** Preserve stable refund key.
- [ ] **P6-14** Preserve invoice binding.
- [ ] **P6-15** Preserve no-spend-restoration rule.
- [ ] **P6-16** Add refund status refresh.
- [ ] **P6-17** Add audit events.

### Webhook TODO

- [ ] **P6-18** Implement retry through inbox/recovery service.
- [ ] **P6-19** Protect against concurrent duplicate retries.
- [ ] **P6-20** Respect lease ownership/state.
- [ ] **P6-21** Add stale lease recovery only if current worker model supports it.
- [ ] **P6-22** Add linked order/payment reconciliation shortcut.
- [ ] **P6-23** Add bounded retry constraints.
- [ ] **P6-24** Add audit events.
- [ ] **P6-25** Add integration and E2E tests.

### Exit criteria

- [ ] Admin can diagnose and recover operational payment/webhook failures.
- [ ] PayPal Sandbox remains authoritative.
- [ ] No duplicated captures/refunds can be caused by an admin retry.
- [ ] Every financial action is idempotent, reasoned, and audited.

**Feeds into:** Phase 7.

---

# Phase 7 — Platform Controls and Kill Switches

**Goal:** Give the main admin safe platform-wide operational control.

**Depends on:** Phases 2, 5, 6.

### TODO

- [ ] **P7-01** Add `PlatformSetting` model/repository.
- [ ] **P7-02** Define typed setting registry.
- [ ] **P7-03** Add setting schema validation.
- [ ] **P7-04** Add version/check-and-set behavior.
- [ ] **P7-05** Add settings API.
- [ ] **P7-06** Add settings UI.
- [ ] **P7-07** Add global autonomy kill switch.
- [ ] **P7-08** Enforce global autonomy setting inside execution path.
- [ ] **P7-09** Add checkout kill switch.
- [ ] **P7-10** Enforce before PayPal order creation.
- [ ] **P7-11** Add refund initiation kill switch.
- [ ] **P7-12** Add shopping agent switch.
- [ ] **P7-13** Add proposal-from-agent switch.
- [ ] **P7-14** Add Demo Catalog switch.
- [ ] **P7-15** Add Channel3 discovery switch.
- [ ] **P7-16** Add maintenance mode.
- [ ] **P7-17** Ensure webhook ingestion/recovery can remain active during maintenance.
- [ ] **P7-18** Add current control banner to admin dashboard.
- [ ] **P7-19** Add clear disabled-state messages in user app/API.
- [ ] **P7-20** Require fresh auth + typed confirmation for critical controls.
- [ ] **P7-21** Audit every setting change.
- [ ] **P7-22** Test every setting at the server enforcement point.

### Exit criteria

- [ ] Every switch works even if the admin UI is bypassed.
- [ ] Controls fail closed where appropriate.
- [ ] Maintenance does not accidentally drop provider webhooks.
- [ ] Current platform mode is visible to the admin.

**Feeds into:** Phase 8.

---

# Phase 8 — System Health, Worker, and AI Observability

**Goal:** Make the admin panel useful for day-to-day operations.

**Depends on:** Existing worker/agent instrumentation plus Phase 4 UI.

### TODO

- [ ] **P8-01** Add API readiness aggregation.
- [ ] **P8-02** Add database health metric.
- [ ] **P8-03** Add worker heartbeat mechanism if missing.
- [ ] **P8-04** Add webhook queue/backlog metrics.
- [ ] **P8-05** Add failed/retrying webhook counts.
- [ ] **P8-06** Add last-success timestamps.
- [ ] **P8-07** Add PayPal Sandbox status probe that does not expose credentials.
- [ ] **P8-08** Add Channel3 health.
- [ ] **P8-09** Add Demo Catalog health.
- [ ] **P8-10** Add agent run operational telemetry.
- [ ] **P8-11** Add agent tool-call metrics.
- [ ] **P8-12** Add agent error classification.
- [ ] **P8-13** Add `/system` page.
- [ ] **P8-14** Add `/agent` page.
- [ ] **P8-15** Add dashboard warning cards for degraded subsystems.
- [ ] **P8-16** Add commit SHA/build version display.
- [ ] **P8-17** Verify telemetry does not store secrets or chain-of-thought.

### Exit criteria

- [ ] Admin can identify which subsystem is degraded.
- [ ] Admin can distinguish API, DB, PayPal, webhook, discovery, and AI failures.
- [ ] Worker liveness/backlog is visible.
- [ ] No sensitive model/provider data is leaked.

**Feeds into:** Phase 9.

---

# Phase 9 — Dashboard Analytics and Operational Reporting

**Goal:** Turn the admin panel into a strong operational dashboard rather than only CRUD screens.

**Depends on:** Phases 4 and 8.

### TODO

- [ ] **P9-01** Add time-range selector.
- [ ] **P9-02** Add user growth chart.
- [ ] **P9-03** Add payment volume chart.
- [ ] **P9-04** Add refund volume chart.
- [ ] **P9-05** Add AgentGuard decision distribution.
- [ ] **P9-06** Add approval funnel.
- [ ] **P9-07** Add checkout funnel.
- [ ] **P9-08** Add webhook health chart.
- [ ] **P9-09** Add top error categories.
- [ ] **P9-10** Add mandate-status distribution.
- [ ] **P9-11** Add agent-run metrics.
- [ ] **P9-12** Add drill-down from charts to filtered list pages.
- [ ] **P9-13** Validate metric definitions.
- [ ] **P9-14** Add query performance tests.
- [ ] **P9-15** Add indexes/materialized aggregation only if actual query profiles require them.

### Exit criteria

- [ ] Dashboard metrics have explicit definitions.
- [ ] Charts link to underlying records.
- [ ] Metrics are performant at expected MVP scale.
- [ ] No chart is based on unbounded browser-side datasets.

---

# Phase 10 — Hardening and Release Readiness

**Goal:** Validate the whole admin application before production deployment.

**Depends on:** All previous phases.

### Security TODO

- [ ] **P10-01** Test all admin endpoints as unauthenticated.
- [ ] **P10-02** Test all admin endpoints as normal authenticated user.
- [ ] **P10-03** Test inactive admin.
- [ ] **P10-04** Test stale/fresh admin auth.
- [ ] **P10-05** Test CSRF/trusted-origin protections.
- [ ] **P10-06** Test rate limits.
- [ ] **P10-07** Test log redaction.
- [ ] **P10-08** Verify no secrets in frontend bundles.
- [ ] **P10-09** Verify no raw PayPal/auth secrets in APIs.
- [ ] **P10-10** Verify audit immutability.
- [ ] **P10-11** Verify all financial actions are idempotent.
- [ ] **P10-12** Verify admin cannot bypass AgentGuard.

### Reliability TODO

- [ ] **P10-13** Test API failure states.
- [ ] **P10-14** Test DB unavailable state.
- [ ] **P10-15** Test PayPal unavailable state.
- [ ] **P10-16** Test worker unavailable state.
- [ ] **P10-17** Test webhook retry races.
- [ ] **P10-18** Test duplicate action submissions.
- [ ] **P10-19** Test stale entity version conflicts.
- [ ] **P10-20** Test large table pagination/filtering.

### UI/UX TODO

- [ ] **P10-21** Desktop QA.
- [ ] **P10-22** Tablet QA.
- [ ] **P10-23** Mobile QA.
- [ ] **P10-24** Keyboard navigation.
- [ ] **P10-25** Screen-reader labels.
- [ ] **P10-26** Loading states.
- [ ] **P10-27** Empty states.
- [ ] **P10-28** Error states.
- [ ] **P10-29** Confirmation flows.
- [ ] **P10-30** Breadcrumbs and deep-link consistency.
- [ ] **P10-31** URL-restorable table filters.

### Documentation TODO

- [ ] **P10-32** Document admin bootstrap process.
- [ ] **P10-33** Document admin environment variables.
- [ ] **P10-34** Document all kill switches.
- [ ] **P10-35** Document financial recovery runbook.
- [ ] **P10-36** Document webhook recovery runbook.
- [ ] **P10-37** Document user-disable/re-enable procedure.
- [ ] **P10-38** Document audit event catalog.
- [ ] **P10-39** Document emergency maintenance procedure.
- [ ] **P10-40** Document rollback procedure.

### Exit criteria

- [ ] Admin app is operationally complete.
- [ ] Critical actions are safe and audited.
- [ ] UI/UX is consistent.
- [ ] Runbooks exist for failure scenarios.
- [ ] Release checklist passes.

---

# 16. Phase Dependency Graph

```text
Existing MandatePay MVP
        │
        ▼
Phase 0 — Verify actual code/contracts
        │
        ▼
Phase 1 — Admin auth/security
        │
        ├───────────────┐
        ▼               ▼
Phase 2 — Audit     Phase 3 — UI foundation
        │               │
        └───────┬───────┘
                ▼
Phase 4 — Read-only operations
                │
                ▼
Phase 5 — User/domain controls
                │
                ▼
Phase 6 — Payment/refund/webhook operations
                │
                ▼
Phase 7 — Platform controls
                │
                ▼
Phase 8 — Health + AI observability
                │
                ▼
Phase 9 — Analytics/reporting
                │
                ▼
Phase 10 — Hardening/release
```

---

# 17. Recommended Initial Route Tree

```text
apps/admin/app/
├── layout.tsx
├── login/
│   └── page.tsx
└── (admin)/
    ├── layout.tsx
    ├── page.tsx
    ├── users/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── mandates/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── proposals/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── approvals/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── orders/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── payments/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── refunds/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── webhooks/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── agent/
    │   ├── page.tsx
    │   └── runs/
    │       └── [id]/
    │           └── page.tsx
    ├── audit/
    │   ├── page.tsx
    │   └── [id]/
    │       └── page.tsx
    ├── system/
    │   └── page.tsx
    └── settings/
        └── platform/
            └── page.tsx
```

---

# 18. Recommended API Module Structure

```text
apps/api/src/modules/admin/
├── admin.routes.ts
├── admin.auth.ts
├── admin.schemas.ts
├── admin.audit.service.ts
├── overview/
│   ├── overview.routes.ts
│   └── overview.service.ts
├── users/
│   ├── users.routes.ts
│   └── users.service.ts
├── mandates/
│   ├── mandates.routes.ts
│   └── mandates.service.ts
├── proposals/
│   ├── proposals.routes.ts
│   └── proposals.service.ts
├── approvals/
│   ├── approvals.routes.ts
│   └── approvals.service.ts
├── orders/
│   ├── orders.routes.ts
│   └── orders.service.ts
├── payments/
│   ├── payments.routes.ts
│   └── payments.service.ts
├── refunds/
│   ├── refunds.routes.ts
│   └── refunds.service.ts
├── webhooks/
│   ├── webhooks.routes.ts
│   └── webhooks.service.ts
├── agent/
│   ├── agent.routes.ts
│   └── agent.service.ts
├── system/
│   ├── system.routes.ts
│   └── system.service.ts
└── settings/
    ├── settings.routes.ts
    └── settings.service.ts
```

Do not copy payment/refund/policy logic into these services.

The admin services should orchestrate existing services.

---

# 19. Recommended Repository Additions

Inside `@mandatepay/database`, consider:

```text
src/repositories/admin/
├── admin-principal.repo.ts
├── admin-audit.repo.ts
├── admin-users.repo.ts
├── admin-mandates.repo.ts
├── admin-proposals.repo.ts
├── admin-orders.repo.ts
├── admin-payments.repo.ts
├── admin-refunds.repo.ts
├── admin-webhooks.repo.ts
├── platform-settings.repo.ts
└── admin-metrics.repo.ts
```

This is preferable to weakening owner-scoped repositories.

---

# 20. Definition of Done for Every Admin Mutation

A mutation is not complete until all boxes pass.

- [ ] Admin authentication checked.
- [ ] Admin active status checked.
- [ ] Fresh auth checked when required.
- [ ] Request body schema validated.
- [ ] Current state loaded.
- [ ] Current state permits action.
- [ ] Reason supplied.
- [ ] Confirmation supplied where required.
- [ ] Existing domain service used.
- [ ] Idempotency handled where applicable.
- [ ] Transaction/concurrency handled.
- [ ] Admin audit written.
- [ ] Safe structured log written.
- [ ] Response contains no secret/provider credential.
- [ ] Unit test exists.
- [ ] Integration test exists.
- [ ] UI success state exists.
- [ ] UI error state exists.
- [ ] Audit page links to the action.

---

# 21. Suggested MVP Admin Scope

For the **first usable admin release**, complete through **Phase 6**.

That gives:

- Secure single-admin access.
- Full operational UI.
- Complete cross-entity visibility.
- User controls.
- Mandate/proposal inspection.
- Payment/order reconciliation.
- Refund visibility and guarded operations.
- Webhook diagnostics/retry.
- Admin audit trail.

Then add:

- Phase 7: platform kill switches.
- Phase 8: deep observability.
- Phase 9: richer analytics.
- Phase 10: full hardening and release readiness.

---

# 22. Features Explicitly Deferred from Admin v1

Do not expand scope prematurely with:

- Multi-admin invitations.
- Granular RBAC editor.
- Admin impersonation.
- Manual database editor.
- Manual payment-state editing.
- Raw SQL console.
- Raw PayPal payload browser.
- Production PayPal controls while the platform is Sandbox-only.
- Vault management while Vault is not implemented.
- Recurrence administration while recurrence is not implemented.
- Price-watch administration while price watch is not implemented.
- Voice administration while voice is not implemented.

---

# 23. Final Admin Capability Map

| Capability | View | Control | Requires reason | Fresh auth | Audit |
|---|---:|---:|---:|---:|---:|
| Dashboard | Yes | No | No | No | No |
| Users | Yes | Yes | Yes | High-risk actions | Yes |
| Sessions | Yes | Revoke | Yes | Recommended | Yes |
| Mandates | Yes | Limited | Yes | Revoke | Yes |
| Proposals | Yes | Re-evaluate | Yes | No | Yes |
| Approvals | Yes | No in v1 | — | — | — |
| Orders | Yes | Reconcile | Yes | No | Yes |
| Payments | Yes | Reconcile | Yes | No | Yes |
| Refunds | Yes | Guarded refund/status | Yes | Refund creation | Yes |
| Webhooks | Yes | Retry/reconcile | Yes | No | Yes |
| Agent | Metrics | Feature control later | Yes | Critical toggle | Yes |
| Audit | Yes | No delete/update | — | — | — |
| System health | Yes | Limited | Yes if mutating | Depends | Yes |
| Platform settings | Yes | Yes | Yes | Critical settings | Yes |

---

# 24. Recommended Build Order

For implementation, use this exact order:

```text
1. Verify actual schema/services
2. AdminPrincipal + requireAdmin
3. Admin audit
4. Admin shell/components
5. Read-only overview
6. Users
7. Mandates
8. Proposals + approvals
9. Orders + payments
10. Refunds
11. Webhooks
12. User/domain admin actions
13. Payment/refund recovery actions
14. Platform settings/kill switches
15. System + worker health
16. Agent observability
17. Dashboard analytics
18. Security/reliability hardening
19. Documentation/runbooks
```

This prevents UI work from getting ahead of the security and domain layers.

---

# 25. Completion Target

The admin module is considered properly implemented when the main administrator can:

1. Sign in securely to `apps/admin`.
2. View the entire platform state without database access.
3. Trace any purchase from user → mandate → proposal → approval → order → payment → refund.
4. Diagnose failed/recovering webhook/payment flows.
5. Safely disable user/platform capabilities.
6. Reconcile provider-backed state without falsifying provider truth.
7. Execute only supported financial recovery operations.
8. See the health of API, DB, PayPal Sandbox, webhooks, discovery, and AI.
9. Search a complete immutable history of privileged admin actions.
10. Operate the platform without exposing or handling raw secrets.
11. Use a consistent, polished, responsive UI.
12. Perform all sensitive operations with confirmation, reason, authorization, and audit logging.

---

## Final architectural rule

```text
Admin UI
  does not own business truth.

Admin API
  does not bypass domain rules.

Existing domain services
  remain authoritative.

PayPal Sandbox
  remains authoritative for provider payment truth.

AgentGuard
  remains authoritative for policy.

Audit records
  make privileged actions traceable.
```
