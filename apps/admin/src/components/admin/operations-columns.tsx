"use client";
import { EntityLink } from "@/components/admin/entity-link";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatUsd } from "@/lib/money";
import { resourceSpecs } from "@/lib/resource-specs";
import { formatUtcDate } from "@/components/admin/timeline";
import type { TableColumn } from "@/components/admin/data-table";
import type {
  AdminUser,
  AdminMandate,
  AdminProposal,
  AdminApproval,
  AdminOrder,
  AdminPayment,
  AdminRefund,
  AdminWebhook,
  AdminAuditEventDTO,
} from "@mandatepay/shared";

export function columnsFor(
  resource: keyof typeof resourceSpecs,
): readonly TableColumn<Record<string, unknown> & { id: string }>[] {
  if (resource === "users")
    return [
      {
        key: "id",
        label: "User",
        render: (row) => <EntityLink resource="users" id={(row as AdminUser).id} />,
      },
      { key: "email", label: "Email", render: (row) => (row as AdminUser).email },
      {
        key: "verified",
        label: "Verified",
        render: (row) => (
          <StatusBadge status={(row as AdminUser).emailVerified ? "VERIFIED" : "UNVERIFIED"} />
        ),
      },
      {
        key: "autonomy",
        label: "Autonomy",
        render: (row) => ((row as AdminUser).autonomousPurchasingEnabled ? "Enabled" : "Off"),
      },
      {
        key: "mandates",
        label: "Active mandates",
        render: (row) => (row as AdminUser).activeMandateCount,
      },
      {
        key: "spend",
        label: "Captured",
        render: (row) => formatUsd((row as AdminUser).capturedGrossMinor),
      },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminUser).createdAt),
      },
    ];
  if (resource === "mandates")
    return [
      {
        key: "id",
        label: "Mandate",
        render: (row) => <EntityLink resource="mandates" id={(row as AdminMandate).id} />,
      },
      {
        key: "owner",
        label: "Owner",
        render: (row) => (
          <EntityLink
            resource="users"
            id={(row as AdminMandate).owner.id}
            label={(row as AdminMandate).owner.email}
          />
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminMandate).status} />,
      },
      { key: "version", label: "Version", render: (row) => (row as AdminMandate).version },
      {
        key: "limit",
        label: "Transaction limit",
        render: (row) => formatUsd((row as AdminMandate).transactionLimitMinor),
      },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminMandate).createdAt),
      },
    ];
  if (resource === "proposals")
    return [
      {
        key: "id",
        label: "Proposal",
        render: (row) => <EntityLink resource="proposals" id={(row as AdminProposal).id} />,
      },
      {
        key: "owner",
        label: "Owner",
        render: (row) => (
          <EntityLink
            resource="users"
            id={(row as AdminProposal).owner.id}
            label={(row as AdminProposal).owner.email}
          />
        ),
      },
      { key: "product", label: "Product", render: (row) => (row as AdminProposal).product.title },
      {
        key: "amount",
        label: "Amount",
        render: (row) => formatUsd((row as AdminProposal).totalMinor),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminProposal).status} />,
      },
      {
        key: "decision",
        label: "Decision",
        render: (row) => (row as AdminProposal).latestDecision?.decision ?? "—",
      },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminProposal).createdAt),
      },
    ];
  if (resource === "approvals")
    return [
      {
        key: "id",
        label: "Approval",
        render: (row) => <EntityLink resource="approvals" id={(row as AdminApproval).id} />,
      },
      {
        key: "owner",
        label: "Owner",
        render: (row) => (
          <EntityLink
            resource="users"
            id={(row as AdminApproval).owner.id}
            label={(row as AdminApproval).owner.email}
          />
        ),
      },
      {
        key: "proposal",
        label: "Proposal",
        render: (row) => <EntityLink resource="proposals" id={(row as AdminApproval).proposalId} />,
      },
      {
        key: "decision",
        label: "Decision",
        render: (row) => <StatusBadge status={(row as AdminApproval).decision} />,
      },
      {
        key: "expiresAt",
        label: "Deadline",
        sortKey: "expiresAt",
        render: (row) => formatUtcDate((row as AdminApproval).expiresAt),
      },
    ];
  if (resource === "orders")
    return [
      {
        key: "id",
        label: "Order",
        render: (row) => <EntityLink resource="orders" id={(row as AdminOrder).id} />,
      },
      {
        key: "owner",
        label: "Owner",
        render: (row) => (
          <EntityLink
            resource="users"
            id={(row as AdminOrder).owner.id}
            label={(row as AdminOrder).owner.email}
          />
        ),
      },
      {
        key: "amount",
        label: "Amount",
        render: (row) => formatUsd((row as AdminOrder).amountMinor),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminOrder).paymentStatus} />,
      },
      {
        key: "reconciliation",
        label: "Reconciliation",
        render: (row) => (row as AdminOrder).reconciliation,
      },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminOrder).createdAt),
      },
    ];
  if (resource === "payments")
    return [
      {
        key: "id",
        label: "Payment",
        render: (row) => <EntityLink resource="payments" id={(row as AdminPayment).id} />,
      },
      {
        key: "owner",
        label: "Owner",
        render: (row) => (
          <EntityLink
            resource="users"
            id={(row as AdminPayment).owner.id}
            label={(row as AdminPayment).owner.email}
          />
        ),
      },
      {
        key: "amount",
        label: "Amount",
        render: (row) => formatUsd((row as AdminPayment).amountMinor),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminPayment).paymentStatus} />,
      },
      { key: "refunds", label: "Refunds", render: (row) => (row as AdminPayment).refundState },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminPayment).createdAt),
      },
    ];
  if (resource === "refunds")
    return [
      {
        key: "id",
        label: "Refund",
        render: (row) => <EntityLink resource="refunds" id={(row as AdminRefund).id} />,
      },
      {
        key: "payment",
        label: "Payment",
        render: (row) => <EntityLink resource="payments" id={(row as AdminRefund).paymentId} />,
      },
      {
        key: "amount",
        label: "Amount",
        render: (row) => formatUsd((row as AdminRefund).amountMinor),
      },
      { key: "kind", label: "Type", render: (row) => (row as AdminRefund).kind },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminRefund).status} />,
      },
      {
        key: "createdAt",
        label: "Created",
        sortKey: "createdAt",
        render: (row) => formatUtcDate((row as AdminRefund).createdAt),
      },
    ];
  if (resource === "webhooks")
    return [
      {
        key: "id",
        label: "Event",
        render: (row) => <EntityLink resource="webhooks" id={(row as AdminWebhook).id} />,
      },
      { key: "type", label: "Type", render: (row) => (row as AdminWebhook).eventType },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={(row as AdminWebhook).status} />,
      },
      { key: "attempts", label: "Attempts", render: (row) => (row as AdminWebhook).attempts },
      { key: "error", label: "Error", render: (row) => (row as AdminWebhook).errorCode ?? "—" },
      {
        key: "receivedAt",
        label: "Received",
        sortKey: "receivedAt",
        render: (row) => formatUtcDate((row as AdminWebhook).receivedAt),
      },
    ];
  return [
    {
      key: "id",
      label: "Event",
      render: (row) => <EntityLink resource="audit" id={(row as AdminAuditEventDTO).id} />,
    },
    { key: "action", label: "Action", render: (row) => (row as AdminAuditEventDTO).action },
    {
      key: "target",
      label: "Target",
      render: (row) =>
        `${(row as AdminAuditEventDTO).targetType} ${(row as AdminAuditEventDTO).targetId}`,
    },
    {
      key: "result",
      label: "Result",
      render: (row) => <StatusBadge status={(row as AdminAuditEventDTO).result} />,
    },
    {
      key: "createdAt",
      label: "Created",
      render: (row) => formatUtcDate((row as AdminAuditEventDTO).createdAt),
    },
  ];
}
