import {
  ADMIN_APPROVAL_DECISIONS,
  ADMIN_PAYMENT_STATUSES,
  ADMIN_REFUND_STATUSES,
  ADMIN_WEBHOOK_STATUSES,
  MANDATE_STATUSES,
  POLICY_DECISIONS,
  PROPOSAL_STATUSES,
} from "@mandatepay/shared";
import type { TableQuerySpec } from "./table-query";
import type { SelectFilter, TextFilter } from "@/components/admin/filters";

const trueFalse = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];
function enums(values: readonly string[]): SelectFilter["options"] {
  return values.map((value) => ({ value, label: value.replaceAll("_", " ") }));
}

export const resourceSpecs = {
  users: {
    spec: {
      search: true,
      dates: true,
      filters: {
        verified: ["true", "false"],
        autonomy: ["true", "false"],
        disabled: ["true", "false"],
        hasActiveMandate: ["true", "false"],
      },
      sortKeys: ["createdAt"],
    } satisfies TableQuerySpec,
    search: { label: "Search name or email" },
    filters: [
      { key: "verified", label: "Verified", options: trueFalse },
      { key: "autonomy", label: "Autonomous purchasing", options: trueFalse },
      { key: "disabled", label: "Disabled", options: trueFalse },
      { key: "hasActiveMandate", label: "Has active mandate", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [] satisfies TextFilter[],
    dates: true,
    caption: "Users",
    path: "/users",
  },
  mandates: {
    spec: {
      search: true,
      dates: true,
      filters: { status: [...MANDATE_STATUSES], effectiveExpired: ["true", "false"] },
      ids: ["userId"],
      sortKeys: ["createdAt"],
    } satisfies TableQuerySpec,
    search: { label: "Search title" },
    filters: [
      { key: "status", label: "Status", options: enums(MANDATE_STATUSES) },
      { key: "effectiveExpired", label: "Effectively expired", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [{ key: "userId", label: "Owner user ID" }] satisfies TextFilter[],
    dates: true,
    caption: "Mandates",
    path: "/mandates",
  },
  proposals: {
    spec: {
      dates: true,
      filters: {
        status: [...PROPOSAL_STATUSES],
        decision: [...POLICY_DECISIONS],
        includeSamples: ["true", "false"],
      },
      ids: ["userId", "mandateId"],
      tokens: ["source"],
      sortKeys: ["createdAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "status", label: "Status", options: enums(PROPOSAL_STATUSES) },
      { key: "decision", label: "Latest decision", options: enums(POLICY_DECISIONS) },
      { key: "includeSamples", label: "Include samples", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "userId", label: "Owner user ID" },
      { key: "mandateId", label: "Mandate ID" },
      { key: "source", label: "Product source" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Proposals",
    path: "/proposals",
  },
  approvals: {
    spec: {
      dates: true,
      filters: {
        decision: [...ADMIN_APPROVAL_DECISIONS],
        effectiveExpired: ["true", "false"],
        includeSamples: ["true", "false"],
      },
      ids: ["userId", "proposalId"],
      sortKeys: ["expiresAt", "createdAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "decision", label: "Decision", options: enums(ADMIN_APPROVAL_DECISIONS) },
      { key: "effectiveExpired", label: "Effectively expired", options: trueFalse },
      { key: "includeSamples", label: "Include samples", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "userId", label: "Owner user ID" },
      { key: "proposalId", label: "Proposal ID" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Approvals",
    path: "/approvals",
  },
  orders: {
    spec: {
      dates: true,
      filters: { status: [...ADMIN_PAYMENT_STATUSES], includeSamples: ["true", "false"] },
      ids: ["userId", "proposalId"],
      tokens: ["paypalOrderId"],
      sortKeys: ["createdAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "status", label: "Payment status", options: enums(ADMIN_PAYMENT_STATUSES) },
      { key: "includeSamples", label: "Include samples", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "userId", label: "Owner user ID" },
      { key: "proposalId", label: "Proposal ID" },
      { key: "paypalOrderId", label: "PayPal order ID" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Orders",
    path: "/orders",
  },
  payments: {
    spec: {
      dates: true,
      filters: {
        status: [...ADMIN_PAYMENT_STATUSES],
        refundState: ["none", "pending", "refunded"],
        dateBasis: ["created", "captured"],
        includeSamples: ["true", "false"],
      },
      ids: ["userId", "mandateId", "proposalId"],
      tokens: ["paypalCaptureId"],
      numbers: ["amountMin", "amountMax"],
      sortKeys: ["createdAt", "capturedAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "status", label: "Status", options: enums(ADMIN_PAYMENT_STATUSES) },
      {
        key: "refundState",
        label: "Refund state",
        options: enums(["none", "pending", "refunded"]),
      },
      { key: "dateBasis", label: "Date basis", options: enums(["created", "captured"]) },
      { key: "includeSamples", label: "Include samples", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "userId", label: "Owner user ID" },
      { key: "mandateId", label: "Mandate ID" },
      { key: "proposalId", label: "Proposal ID" },
      { key: "paypalCaptureId", label: "PayPal capture ID" },
      { key: "amountMin", label: "Min amount (minor)", kind: "number" },
      { key: "amountMax", label: "Max amount (minor)", kind: "number" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Payments",
    path: "/payments",
  },
  refunds: {
    spec: {
      dates: true,
      filters: { status: [...ADMIN_REFUND_STATUSES], includeSamples: ["true", "false"] },
      ids: ["userId", "paymentId"],
      tokens: ["paypalRefundId"],
      sortKeys: ["createdAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "status", label: "Status", options: enums(ADMIN_REFUND_STATUSES) },
      { key: "includeSamples", label: "Include samples", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "userId", label: "Owner user ID" },
      { key: "paymentId", label: "Payment ID" },
      { key: "paypalRefundId", label: "PayPal refund ID" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Refunds",
    path: "/refunds",
  },
  webhooks: {
    spec: {
      dates: true,
      filters: {
        status: [...ADMIN_WEBHOOK_STATUSES],
        retryEligible: ["true", "false"],
        stale: ["true", "false"],
        exhausted: ["true", "false"],
      },
      tokens: ["providerEventId", "eventType"],
      sortKeys: ["receivedAt"],
    } satisfies TableQuerySpec,
    filters: [
      { key: "status", label: "Status", options: enums(ADMIN_WEBHOOK_STATUSES) },
      { key: "retryEligible", label: "Retry eligible", options: trueFalse },
      { key: "stale", label: "Stale lease", options: trueFalse },
      { key: "exhausted", label: "Exhausted", options: trueFalse },
    ] satisfies SelectFilter[],
    fields: [
      { key: "providerEventId", label: "Provider event ID" },
      { key: "eventType", label: "Event type" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Webhook inbox",
    path: "/webhooks",
  },
  audit: {
    spec: {
      dates: true,
      filters: {
        action: [
          "ADMIN_LOGIN_SUCCEEDED",
          "ADMIN_LOGIN_FAILED",
          "ADMIN_REAUTH_SUCCEEDED",
          "ADMIN_REAUTH_FAILED",
          "ADMIN_LOGOUT_SUCCEEDED",
          "ADMIN_USER_DISABLED",
          "ADMIN_USER_ENABLED",
          "ADMIN_SESSIONS_REVOKED",
          "ADMIN_AUTONOMY_DISABLED",
          "ADMIN_NOTE_ADDED",
          "ADMIN_MANDATE_PAUSED",
          "ADMIN_MANDATE_REVOKED",
          "ADMIN_PAYMENT_RECONCILE_REQUESTED",
          "ADMIN_REFUND_REQUESTED",
          "ADMIN_WEBHOOK_RETRY_REQUESTED",
          "ADMIN_WEBHOOK_RECONCILE_REQUESTED",
          "ADMIN_FEATURE_FLAG_CHANGED",
          "ADMIN_MAINTENANCE_MODE_CHANGED",
        ],
        targetType: [
          "ADMIN_AUTH",
          "ADMIN_SESSION",
          "USER",
          "MANDATE",
          "PROPOSAL",
          "APPROVAL",
          "PAYMENT",
          "REFUND",
          "WEBHOOK",
          "PLATFORM_SETTING",
          "SYSTEM",
        ],
        result: ["PENDING", "SUCCESS", "FAILURE"],
      },
      ids: ["targetId", "actorAdminId", "correlationId"],
    } satisfies TableQuerySpec,
    filters: [
      {
        key: "action",
        label: "Action",
        options: enums([
          "ADMIN_LOGIN_SUCCEEDED",
          "ADMIN_LOGIN_FAILED",
          "ADMIN_REAUTH_SUCCEEDED",
          "ADMIN_REAUTH_FAILED",
          "ADMIN_LOGOUT_SUCCEEDED",
        ]),
      },
      {
        key: "result",
        label: "Result",
        options: enums(["PENDING", "SUCCESS", "FAILURE"]),
      },
    ] satisfies SelectFilter[],
    fields: [
      { key: "targetId", label: "Target ID" },
      { key: "actorAdminId", label: "Actor admin ID" },
      { key: "correlationId", label: "Correlation ID" },
    ] satisfies TextFilter[],
    dates: true,
    caption: "Admin audit",
    path: "/audit",
  },
} as const;
