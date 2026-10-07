# Shared admin UI contract

Admin Phase 3 supplies the protected shell and reusable components under `apps/admin/src/components/admin`. Import from its `index.ts` for future modules. The shared Button, Separator and Radix-based Dialog remain in `@mandatepay/ui`. Identity, mutation authority, fresh authentication, audit writes and idempotency remain API responsibilities; see [admin-api.md](./admin-api.md).

## Shell and display

The protected layout authorizes through the existing no-store session helper before rendering `AdminShell`. It provides `AdminSidebar`, `AdminTopbar`, a focusable main landmark and `AdminToastProvider`. Root layout retains the skip link. The desktop sidebar scrolls independently; tablet/mobile navigation is a modal drawer with its own scrolling region, focus trapping, Escape/scrim dismissal and focus restoration. Enable navigation items only when the corresponding phase implements a real route. Phase 4 enables Overview, Users, Mandates, Proposals, Approvals, Orders, Payments, Refunds, Webhooks, Audit Logs and My Session. Phase 5 adds mutation controls on user, mandate and proposal detail pages. Phase 6 adds payment, refund and webhook recovery. Phase 7 enables Configuration at `/settings` and the overview platform-mode banner. Phase 8 enables Agent Activity at `/agent` and System Health at `/system`, plus overview warning cards for subsystems that are not ready.

Use `PageHeader` with `Breadcrumbs`, `MetricCard`, `StatusBadge`, `HealthIndicator`, `LoadingSkeleton`, `EmptyState` and `ErrorState`. Unavailable metric values must be `null`/`undefined`, with an explanation; they render an em dash and unavailable status rather than zero. Status always has readable text, not color alone. Error copy must be safe product text rather than raw exceptions/provider responses. Give `ErrorState` a real retry handler when recovery is available.

`ADMIN_ENVIRONMENT=local|test|staging|production` is a display-only, server-read deployment label passed to the shell. If omitted, a loopback admin origin implies Local; other origins show Environment unknown. A production Next build does not identify its deployment environment or grant authority. The root environment loader imports only this approved label alongside the existing origin/API configuration; Turbo includes it in relevant task environments.

## Server-driven collections

Define a resource-specific `TableQuerySpec` in a pure module. Use `readTableQuery` in the server page and `useTableQuery(spec)` in its client adapter. API requests must use only the resource's approved parameters. Search/sort capabilities are opt-in; do not offer them against APIs that do not support them. The fixture spec is synthetic and does not broaden the audit API contract.

`DataTable<T>` takes typed column renderers, stable row IDs, optional real detail links, `TableState<T>`, sorting and cursor callbacks. Its ready state is `{ status: "ready", data, page: { limit, nextCursor } }`; loading and error are separate states. Rows are supplied by the server. The component does not silently filter/sort the displayed page or invent global counts. Empty data is an actual empty result, not a failed request. Desktop uses a semantic, horizontally scrollable table; tablet/mobile renders the same columns as complete cards and exposes sorting separately. Detail navigation uses anchors, preserving keyboard and open-in-new-tab behavior.

Connect the adapter as follows:

```tsx
const navigation = useTableQuery(resourceSpec);
<FilterBar navigation={navigation} search={{ label: "Search records" }} filters={filters} dates />;
<DataTable
  caption="Records"
  state={serverState}
  columns={columns}
  getRowId={(row) => row.id}
  rowHref={(row) => `/implemented-resource/${encodeURIComponent(row.id)}`}
  pending={navigation.pending}
  onRetry={reloadFromServer}
  onNext={navigation.next}
  onPrevious={navigation.previous}
  hasPrevious={navigation.hasPrevious}
  sort={{ key: navigation.query.sort, direction: navigation.query.direction }}
  onSort={navigation.sort}
/>;
```

This example is an integration pattern used by Phase 4 operations collections. Supply the actual API DTO, query specification, implemented detail route and safe retry handler in each resource.

`FilterBar`, `SearchInput`, `DateRangeFilter` and `Pagination` share URL state. Applying filters/sort/page size resets the cursor; clear removes filters. Query validation rejects duplicate/unknown keys, invalid enums, oversized search/cursors, invalid dates and limits outside 1–100. Date controls show UTC calendar dates and convert inclusive Through to an exclusive next-midnight upper bound. Paired ranges are bounded to 366 days; applying unrelated controls preserves bookmarked timestamp precision when calendar dates are unchanged.

Back/forward and reload restore filters. The Next/Previous cursor trail holds at most ten visited pages for the current view. A direct cursor bookmark has no fabricated Previous cursor; browser Back remains available. Server cursors stay opaque and require API validation. Pagination reports only current-page rows and the configured limit. Transitioning controls are disabled and collections expose busy state.

## Privileged actions

Use `ConfirmDialog` for confirmation, `ReasonDialog` for a required reason, and `DangerConfirmDialog` for high-risk operations. Supply a concrete target ID/label, consequence description, action label, controlled open state and `onConfirm`. High risk requires a reason, exact typed target ID, API-issued `freshAuthUntil`, password confirmation when stale and a separate final review. `ReauthDialog` calls the actual same-origin reauthentication endpoint, clears the password immediately, retains safe wrong-password errors and redirects revoked/unauthorized sessions.

The common `ActionConfirmation` contains a validated reason or null, typed confirmation or null, and UUID request key. Pass a stable operation/version `intentKey`; change it only after authoritative state establishes a new intent. The dialog retains the same payload/key through retries and reopening while mounted, freezes inputs after submission, prevents duplicate submissions and prevents dismissal during a pending request. A page adapter must additionally preserve the API's durable action identity across reloads and recover an unknown outcome before creating a new request. The UI key is not a substitute for backend concurrency/idempotency enforcement.

Return `{ status: "success" }` only for a confirmed outcome or `{ status: "pending" }` for an unresolved outcome. Unknown errors produce safe generic copy. Map recognized API outcomes into closed `AdminActionError` codes; never throw raw provider/request text for display. `useAdminToast` offers persistent, explicitly dismissible success/info/error announcements (up to three), including a distinct pending message. Backend guards must recheck authorization, fresh authentication, typed target, reason, current state and auditability immediately before mutation.

Phase 5 wires those dialogs on operations detail pages. User disable, session revoke, mandate pause and mandate revoke use `DangerConfirmDialog`. Disable-autonomy, enable and proposal re-evaluate use `ReasonDialog`. Notes submit a reason plus bounded body. Phase 6 adds payment/order reconcile and webhook retry/linked reconcile as `ReasonDialog` actions, remaining-refund initiation as `DangerConfirmDialog` with amount review, and refund status refresh as `ReasonDialog`. Server capabilities disable buttons that are not allowed (singleton disable, sample re-eval, invalid mandate status, missing PayPal order ID, no remaining refundable amount, ineligible webhook). Adapters send expected `updatedAt`/`accessVersion` or mandate `version`/`status` from the rendered record and preserve the dialog `requestKey` through retry while mounted.

Phase 7 renders `/settings` from `GET /api/admin/settings`. Non-critical switches use `ReasonDialog`. Maintenance, global autonomy, checkout, refund initiation and webhook processing use `DangerConfirmDialog`, typing the setting key and requiring fresh authentication. The overview banner shows the current platform mode and links to Configuration. The API enforces the same switches when the UI is bypassed.

## Events and safe summaries

Use `EventTimeline` for already-safe product events and `AuditTimeline` for validated admin audit DTOs. Audit data is defensively projected again; malformed rows render an error, and real zero-row results render empty. Actor, action, result, target, reason and UTC timestamp remain visible. `JsonViewer` accepts target-specific summary data and runs `buildAdminSummary` before rendering expandable before/after scalar fields. Never pass arbitrary request/provider payloads into an event description, reason or notification. `EntityLink` builds bounded, encoded local links; callers must enable only implemented resource destinations.

## Verification surface

`/ui-fixtures` and `/ui-fixtures/:id` exercise these patterns with explicitly synthetic records. The normal admin guard still applies; the server additionally requires `ADMIN_UI_FIXTURES=1`, `ADMIN_ENVIRONMENT=test` and a loopback `ADMIN_ORIGIN`. Otherwise the routes return not found. This flag is deliberately excluded from root environment imports and Turbo task environments. Only the isolated browser harness sets it directly on its local Next process. Fixture actions simulate outcomes without invoking business mutations. Real identity/BFF/reauthentication/session rotation are independently covered by browser tests.

See [Phase 3 evidence](../implementation/ADMIN_PHASE_3.md) for commands, accessibility/responsive checks and qualification boundaries, [Phase 5 evidence](../implementation/ADMIN_PHASE_5.md) for user/domain mutation adapters, [Phase 6 evidence](../implementation/ADMIN_PHASE_6.md) for payment/refund/webhook recovery adapters, and [Phase 7 evidence](../implementation/ADMIN_PHASE_7.md) for platform controls.
