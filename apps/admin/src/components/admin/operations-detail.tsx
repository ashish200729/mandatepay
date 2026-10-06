import { notFound } from "next/navigation";
import { PageHeader } from "@/components/admin/page-header";
import { DefinitionList } from "@/components/admin/definition-list";
import { EntityLink } from "@/components/admin/entity-link";
import { StatusBadge } from "@/components/admin/status-badge";
import { JsonViewer } from "@/components/admin/timeline";
import { EventTimeline, formatUtcDate } from "@/components/admin/timeline";
import { adminApi } from "@/lib/admin-fetch";
import { formatUsd } from "@/lib/money";
import { resourceSpecs } from "@/lib/resource-specs";
import {
  parseAdminApproval,
  parseAdminAuditEvent,
  parseAdminDetail,
  parseAdminDomainAudit,
  parseAdminList,
  parseAdminMandate,
  parseAdminNote,
  parseAdminNullableDetail,
  parseAdminPayment,
  parseAdminProposal,
  parseAdminRefund,
  parseAdminReservation,
  parseAdminUser,
  parseAdminUserSession,
  parseAdminWebhook,
  type AdminAuditTarget,
} from "@mandatepay/shared";
import Link from "next/link";
import {
  UserControls,
  UserNotes,
  MandateControls,
  ProposalControls,
  PaymentControls,
  RefundControls,
  WebhookControls,
} from "./admin-actions";

export async function OperationsDetail({
  resource,
  id,
}: {
  resource: keyof typeof resourceSpecs;
  id: string;
}) {
  const config = resourceSpecs[resource];
  const response = await adminApi(
    `/api/admin/${resource === "audit" ? "audit" : resource}/${encodeURIComponent(id)}`,
  );
  if (response.status === 404) notFound();
  const data = parseDetail(resource, response.json);
  if (!data) notFound();
  return (
    <>
      <PageHeader
        title={`${
          {
            users: "User",
            mandates: "Mandate",
            proposals: "Proposal",
            approvals: "Approval",
            orders: "Order",
            payments: "Payment",
            refunds: "Refund",
            webhooks: "Webhook event",
            audit: "Audit event",
          }[resource]
        } ${id}`}
        description="Operational record. Access and mandate controls cannot rewrite PayPal or AgentGuard truth."
        breadcrumbs={[
          { label: "Overview", href: "/" },
          { label: config.caption, href: config.path },
          { label: id },
        ]}
      />
      {renderDetail(resource, data)}
    </>
  );
}

function parseDetail(resource: keyof typeof resourceSpecs, json: unknown) {
  switch (resource) {
    case "users":
      return parseAdminDetail(json, parseAdminUser)?.data;
    case "mandates":
      return parseAdminDetail(json, parseAdminMandate)?.data;
    case "proposals":
      return parseAdminDetail(json, parseAdminProposal)?.data;
    case "approvals":
      return parseAdminDetail(json, parseAdminApproval)?.data;
    case "orders":
      return parseAdminDetail(json, parseAdminPayment)?.data;
    case "payments":
      return parseAdminDetail(json, parseAdminPayment)?.data;
    case "refunds":
      return parseAdminDetail(json, parseAdminRefund)?.data;
    case "webhooks":
      return parseAdminDetail(json, parseAdminWebhook)?.data;
    case "audit":
      return parseAdminDetail(json, parseAdminAuditEvent)?.data;
  }
}

function renderDetail(resource: keyof typeof resourceSpecs, data: unknown) {
  if (resource === "users") {
    const row = data as NonNullable<ReturnType<typeof parseAdminUser>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            { label: "Email", value: row.email },
            { label: "Name", value: row.name ?? "—" },
            {
              label: "Verified",
              value: <StatusBadge status={row.emailVerified ? "VERIFIED" : "UNVERIFIED"} />,
            },
            {
              label: "Autonomous purchasing",
              value: row.autonomousPurchasingEnabled ? "Enabled" : "Off",
            },
            { label: "Active mandates", value: row.activeMandateCount },
            { label: "Proposals", value: row.proposalCount },
            { label: "Captured spend", value: formatUsd(row.capturedGrossMinor) },
            { label: "Last activity (observed proxy)", value: formatUtcDate(row.lastActivityAt) },
            {
              label: "Access status",
              value: (
                <StatusBadge status={row.accessStatus === "disabled" ? "DISABLED" : "ENABLED"} />
              ),
            },
            { label: "Access detail", value: row.accessStatusReason ?? "Account can sign in." },
            { label: "Disabled at", value: row.disabledAt ? formatUtcDate(row.disabledAt) : "—" },
            { label: "Created", value: formatUtcDate(row.createdAt) },
          ]}
        />
        <UserControls user={row} />
        <Related
          links={[
            { href: `/mandates?userId=${encodeURIComponent(row.id)}`, label: "Mandates" },
            { href: `/proposals?userId=${encodeURIComponent(row.id)}`, label: "Proposals" },
            { href: `/orders?userId=${encodeURIComponent(row.id)}`, label: "Orders" },
            { href: `/payments?userId=${encodeURIComponent(row.id)}`, label: "Payments" },
            { href: `/refunds?userId=${encodeURIComponent(row.id)}`, label: "Refunds" },
          ]}
        />
        <UserExtras userId={row.id} />
      </div>
    );
  }
  if (resource === "mandates") {
    const row = data as NonNullable<ReturnType<typeof parseAdminMandate>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            {
              label: "Owner",
              value: <EntityLink resource="users" id={row.owner.id} label={row.owner.email} />,
            },
            { label: "Title", value: row.title },
            { label: "Status", value: <StatusBadge status={row.status} /> },
            { label: "Version", value: row.version },
            { label: "Transaction limit", value: formatUsd(row.transactionLimitMinor) },
            { label: "Automatic limit", value: formatUsd(row.autoSpendLimitMinor) },
            { label: "Starts", value: formatUtcDate(row.startsAt) },
            { label: "Expires", value: formatUtcDate(row.expiresAt) },
            { label: "Effectively expired", value: row.effectiveExpired ? "Yes" : "No" },
          ]}
        />
        <JsonViewer
          targetType={"MANDATE" as AdminAuditTarget}
          summary={{ status: row.status, version: row.version, currency: row.currency }}
          label="Safe mandate summary"
        />
        {row.rules && (
          <pre className="overflow-auto rounded-2xl bg-secondary p-4 text-xs">
            {JSON.stringify(row.rules, null, 2)}
          </pre>
        )}
        <Related
          links={[
            {
              href: `/proposals?mandateId=${encodeURIComponent(row.id)}`,
              label: "Related proposals",
            },
            {
              href: `/payments?mandateId=${encodeURIComponent(row.id)}`,
              label: "Related payments",
            },
            { href: `/users/${encodeURIComponent(row.owner.id)}`, label: "Owner" },
          ]}
        />
        <MandateControls mandate={row} />
      </div>
    );
  }
  if (resource === "proposals") {
    const row = data as NonNullable<ReturnType<typeof parseAdminProposal>>;
    return <ProposalDetail id={row.id} row={row} />;
  }
  if (resource === "approvals") {
    const row = data as NonNullable<ReturnType<typeof parseAdminApproval>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            {
              label: "Owner",
              value: <EntityLink resource="users" id={row.owner.id} label={row.owner.email} />,
            },
            { label: "Proposal", value: <EntityLink resource="proposals" id={row.proposalId} /> },
            { label: "Decision", value: <StatusBadge status={row.decision} /> },
            { label: "Product", value: row.productTitle },
            { label: "Amount", value: formatUsd(row.proposalTotalMinor) },
            { label: "Deadline", value: formatUtcDate(row.expiresAt) },
            { label: "Decided", value: row.decidedAt ? formatUtcDate(row.decidedAt) : "—" },
            { label: "Effectively expired", value: row.effectiveExpired ? "Yes" : "No" },
          ]}
        />
        <Related
          links={[
            {
              href: `/payments?proposalId=${encodeURIComponent(row.proposalId)}`,
              label: "Payment",
            },
            { href: `/orders?proposalId=${encodeURIComponent(row.proposalId)}`, label: "Order" },
          ]}
        />
      </div>
    );
  }
  if (resource === "orders" || resource === "payments") {
    const row = data as NonNullable<ReturnType<typeof parseAdminPayment>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            {
              label: "Owner",
              value: <EntityLink resource="users" id={row.owner.id} label={row.owner.email} />,
            },
            { label: "Proposal", value: <EntityLink resource="proposals" id={row.proposalId} /> },
            { label: "Mandate", value: <EntityLink resource="mandates" id={row.mandateId} /> },
            { label: "Amount", value: formatUsd(row.amountMinor) },
            { label: "Payment status", value: <StatusBadge status={row.paymentStatus} /> },
            { label: "Proposal status", value: <StatusBadge status={row.proposalStatus} /> },
            { label: "PayPal order ID", value: row.paypalOrderId ?? "—" },
            { label: "PayPal capture ID", value: row.paypalCaptureId ?? "—" },
            { label: "Captured", value: row.capturedAt ? formatUtcDate(row.capturedAt) : "—" },
            { label: "Reconciliation", value: row.reconciliation },
            { label: "Refund state", value: row.refundState },
            { label: "Refunded", value: formatUsd(row.refundedMinor) },
            { label: "Remaining refundable", value: formatUsd(row.remainingRefundableMinor) },
            { label: "Failure code", value: row.failureCode ?? "—" },
          ]}
        />
        <PaymentControls payment={row} resource={resource} />
        <Related
          links={[
            { href: `/refunds?paymentId=${encodeURIComponent(row.id)}`, label: "Refunds" },
            { href: `/orders/${encodeURIComponent(row.id)}`, label: "Order view" },
            { href: `/payments/${encodeURIComponent(row.id)}`, label: "Payment view" },
          ]}
        />
      </div>
    );
  }
  if (resource === "refunds") {
    const row = data as NonNullable<ReturnType<typeof parseAdminRefund>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            {
              label: "Owner",
              value: <EntityLink resource="users" id={row.owner.id} label={row.owner.email} />,
            },
            { label: "Payment", value: <EntityLink resource="payments" id={row.paymentId} /> },
            { label: "Invoice ID", value: row.invoiceId },
            { label: "Amount", value: formatUsd(row.amountMinor) },
            { label: "Type", value: row.kind },
            { label: "Status", value: <StatusBadge status={row.status} /> },
            { label: "PayPal refund ID", value: row.paypalRefundId ?? "—" },
            { label: "Settled", value: row.settledAt ? formatUtcDate(row.settledAt) : "—" },
            { label: "Reason", value: row.reason ?? "—" },
            { label: "Failure code", value: row.failureCode ?? "—" },
          ]}
        />
        <RefundControls refund={row} />
      </div>
    );
  }
  if (resource === "webhooks") {
    const row = data as NonNullable<ReturnType<typeof parseAdminWebhook>>;
    return (
      <div className="space-y-8">
        <DefinitionList
          items={[
            { label: "Provider event ID", value: row.providerEventId },
            { label: "Event type", value: row.eventType },
            { label: "Verified", value: row.signatureVerified ? "Yes" : "No" },
            { label: "Status", value: <StatusBadge status={row.status} /> },
            { label: "Attempts", value: row.attempts },
            { label: "Stale lease", value: row.stale ? "Yes" : "No" },
            { label: "Retry eligible", value: row.retryEligible ? "Yes" : "No" },
            { label: "Exhausted", value: row.exhausted ? "Yes" : "No" },
            { label: "Error", value: row.errorCode ?? "—" },
            { label: "Received", value: formatUtcDate(row.receivedAt) },
            {
              label: "Linked payment",
              value: row.paymentId ? <EntityLink resource="payments" id={row.paymentId} /> : "—",
            },
            {
              label: "Linked refund",
              value: row.refundId ? <EntityLink resource="refunds" id={row.refundId} /> : "—",
            },
          ]}
        />
        <WebhookControls webhook={row} />
      </div>
    );
  }
  const row = data as NonNullable<ReturnType<typeof parseAdminAuditEvent>>;
  return (
    <EventTimeline
      events={[
        {
          id: row.id,
          title: row.action,
          at: row.createdAt,
          status: row.result,
          description: row.reason,
        },
      ]}
    />
  );
}

function Related({ links }: { links: readonly { href: string; label: string }[] }) {
  return (
    <nav aria-label="Related records" className="flex flex-wrap gap-3">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="inline-flex min-h-11 items-center rounded-xl border px-4 text-sm underline-offset-4 hover:underline"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

async function UserExtras({ userId }: { userId: string }) {
  const [sessions, audit, notes] = await Promise.all([
    adminApi(`/api/admin/users/${encodeURIComponent(userId)}/sessions?limit=10`),
    adminApi(`/api/admin/domain-audit?userId=${encodeURIComponent(userId)}&limit=20`),
    adminApi(`/api/admin/users/${encodeURIComponent(userId)}/notes?limit=20`),
  ]);
  const sessionRows = parseAdminList(sessions.json, parseAdminUserSession);
  const auditRows = parseAdminList(audit.json, parseAdminDomainAudit);
  const noteRows = parseAdminList(notes.json, parseAdminNote);
  return (
    <>
      <UserNotes userId={userId} notes={noteRows?.data ?? []} />
      <section>
        <h2 className="mb-3 text-lg font-medium">Sessions</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Live or expired sessions for this user. Tokens, IP addresses and user agents are not
          shown.
        </p>
        <ul className="space-y-2 text-sm">
          {(sessionRows?.data ?? []).map((session) => (
            <li key={session.id} className="rounded-xl border bg-card p-4">
              Created {formatUtcDate(session.createdAt)} · expires{" "}
              {formatUtcDate(session.expiresAt)} · {session.isCurrent ? "current" : "expired"}
            </li>
          ))}
          {!sessionRows?.data.length && <li>No sessions on this page.</li>}
        </ul>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-medium">Domain audit</h2>
        <EventTimeline
          events={(auditRows?.data ?? []).map((event) => ({
            id: event.id,
            title: event.eventType,
            at: event.createdAt,
            status: event.entityType,
            description: `${event.entityType} ${event.entityId}`,
          }))}
          emptyDescription="No domain audit events for this user."
        />
      </section>
    </>
  );
}

async function ProposalDetail({
  id,
  row,
}: {
  id: string;
  row: NonNullable<ReturnType<typeof parseAdminProposal>>;
}) {
  const reservation = parseAdminNullableDetail(
    (await adminApi(`/api/admin/proposals/${encodeURIComponent(id)}/reservation`)).json,
    parseAdminReservation,
  );
  return (
    <div className="space-y-8">
      <DefinitionList
        items={[
          {
            label: "Owner",
            value: <EntityLink resource="users" id={row.owner.id} label={row.owner.email} />,
          },
          { label: "Mandate", value: <EntityLink resource="mandates" id={row.mandateId} /> },
          { label: "Product", value: row.product.title },
          { label: "Merchant", value: row.product.merchant },
          { label: "Amount", value: formatUsd(row.totalMinor) },
          { label: "Status", value: <StatusBadge status={row.status} /> },
          { label: "Decision", value: row.latestDecision?.decision ?? "—" },
          { label: "Checkout eligible", value: row.checkoutEligible ? "Recorded eligible" : "No" },
          { label: "Eligibility note", value: row.checkoutEligibilityNote },
          {
            label: "Approval",
            value: row.approvalId ? <EntityLink resource="approvals" id={row.approvalId} /> : "—",
          },
          {
            label: "Payment",
            value: row.paymentId ? <EntityLink resource="payments" id={row.paymentId} /> : "—",
          },
        ]}
      />
      {row.latestDecision && (
        <p className="text-sm text-muted-foreground">
          Reason codes: {row.latestDecision.reasonCodes.join(", ") || "None"}
        </p>
      )}
      {reservation?.data && (
        <p className="text-sm">
          Reservation {reservation.data.id} · {reservation.data.status} ·{" "}
          {formatUsd(reservation.data.amountMinor)}
        </p>
      )}
      <ProposalControls proposal={row} />
    </div>
  );
}
