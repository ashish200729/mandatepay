import { z } from "zod";
import {
  AdminNoteBodySchema,
  AdminReasonSchema,
  AdminResourceIdSchema,
  AdminTraceIdSchema,
} from "./admin-audit.js";
import { CanonicalMandateSchema, PRODUCT_CONDITIONS, type CanonicalMandate } from "./mandates.js";
import { POLICY_DECISIONS, POLICY_REASON_CODES } from "./policy.js";
import { MANDATE_STATUSES, PROPOSAL_STATUSES } from "./state-machine.js";

export const ADMIN_PAYMENT_STATUSES = [
  "CREATED",
  "APPROVED",
  "CAPTURE_PENDING",
  "COMPLETED",
  "DENIED",
  "FAILED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;
export const ADMIN_REFUND_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const ADMIN_APPROVAL_DECISIONS = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export const ADMIN_WEBHOOK_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "IGNORED",
] as const;
export const ADMIN_RESERVATION_STATUSES = [
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
  "FAILED",
] as const;
export const ADMIN_RESERVATION_WINDOWS = ["TRANSACTION", "DAILY", "WEEKLY", "MONTHLY"] as const;
export const ADMIN_PRODUCT_CONDITIONS = [...PRODUCT_CONDITIONS, "UNKNOWN"] as const;
export const ADMIN_DOMAIN_EVENT_TYPES = [
  "USER_CREATED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_SESSIONS_REVOKED",
  "GLOBAL_AUTONOMY_UPDATED",
  "MANDATE_PARSE_REQUESTED",
  "MANDATE_PARSED",
  "MANDATE_CREATED",
  "MANDATE_ACTIVATED",
  "MANDATE_UPDATED",
  "MANDATE_PAUSED",
  "MANDATE_RESUMED",
  "MANDATE_REVOKED",
  "MANDATE_EXPIRED",
  "PRODUCT_SEARCH_REQUESTED",
  "PRODUCT_SEARCH_COMPLETED",
  "PRODUCT_SELECTED",
  "PURCHASE_PROPOSAL_CREATED",
  "POLICY_EVALUATION_STARTED",
  "POLICY_ALLOWED",
  "POLICY_APPROVAL_REQUIRED",
  "POLICY_BLOCKED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "SPEND_RESERVED",
  "SPEND_RESERVATION_RELEASED",
  "SPEND_RESERVATION_CONSUMED",
  "PAYPAL_ORDER_CREATED",
  "PAYPAL_ORDER_APPROVED",
  "PAYMENT_CAPTURE_REQUESTED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
  "PAYPAL_WEBHOOK_RECEIVED",
  "REFUND_REQUESTED",
  "REFUND_APPROVED",
  "PAYPAL_REFUND_CREATED",
  "REFUND_COMPLETED",
  "REFUND_FAILED",
] as const;
export const ADMIN_DOMAIN_ENTITY_TYPES = [
  "USER",
  "PAYMENT_PROFILE",
  "MANDATE",
  "MANDATE_VERSION",
  "MANDATE_RULE",
  "PRODUCT_SNAPSHOT",
  "PURCHASE_PROPOSAL",
  "POLICY_DECISION",
  "APPROVAL",
  "SPEND_RESERVATION",
  "PAYMENT",
  "REFUND",
  "WEBHOOK_EVENT",
] as const;
export const ADMIN_POLICY_REASON_CODES = [
  ...POLICY_REASON_CODES,
  "INVALID_POLICY_INPUT",
  "PRODUCT_DATA_UNTRUSTED",
  "MANDATE_ID_MISMATCH",
  "MANDATE_VERSION_MISMATCH",
  "PROPOSAL_PRODUCT_MISMATCH",
  "PROPOSAL_QUANTITY_MISMATCH",
  "PROPOSAL_TOTAL_MISMATCH",
  "PRODUCT_PRICE_MISMATCH",
  "CURRENCY_MISMATCH",
  "SPEND_CONTEXT_INVALID",
] as const;
export const ACTIVE_PROPOSAL_STATUSES = [
  "PROPOSED",
  "POLICY_CHECKED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "AUTHORIZED",
  "PAYPAL_ORDER_CREATED",
  "PAYMENT_PENDING",
] as const;
export const CAPTURED_PAYMENT_STATUSES = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
export const HIGH_RISK_ADMIN_ACTIONS = [
  "ADMIN_USER_DISABLED",
  "ADMIN_USER_ENABLED",
  "ADMIN_SESSIONS_REVOKED",
  "ADMIN_AUTONOMY_DISABLED",
  "ADMIN_MANDATE_PAUSED",
  "ADMIN_MANDATE_REVOKED",
  "ADMIN_PAYMENT_RECONCILE_REQUESTED",
  "ADMIN_REFUND_REQUESTED",
  "ADMIN_WEBHOOK_RETRY_REQUESTED",
  "ADMIN_WEBHOOK_RECONCILE_REQUESTED",
  "ADMIN_FEATURE_FLAG_CHANGED",
  "ADMIN_MAINTENANCE_MODE_CHANGED",
] as const;
export const HIGH_RISK_DOMAIN_EVENTS = [
  "PAYMENT_FAILED",
  "REFUND_FAILED",
  "USER_DISABLED",
] as const;
export const ADMIN_WEBHOOK_ERROR_CODES = [
  "RECOVERY_EXHAUSTED",
  "WEBHOOK_TIMEOUT",
  "SIGNATURE_INVALID",
  "PROVIDER_PENDING",
  "WEBHOOK_PROCESSING_FAILED",
] as const;
export const ADMIN_OPERATION_CAPABILITIES = [
  "session:read",
  "session:reauthenticate",
  "session:sign-out",
  "audit:read",
  "overview:read",
  "users:read",
  "mandates:read",
  "proposals:read",
  "approvals:read",
  "orders:read",
  "payments:read",
  "refunds:read",
  "webhooks:read",
  "domain-audit:read",
  "exports:read",
  "users:disable",
  "users:enable",
  "users:revoke-sessions",
  "users:disable-autonomy",
  "users:notes",
  "mandates:pause",
  "mandates:revoke",
  "proposals:re-evaluate",
] as const;
export const ADMIN_ENTITY_ACTIONS = [
  "users:disable",
  "users:enable",
  "users:revoke-sessions",
  "users:disable-autonomy",
  "users:notes",
  "mandates:pause",
  "mandates:revoke",
  "proposals:re-evaluate",
] as const;
export const ADMIN_CSV_MAX_ROWS = 1000;
export const ADMIN_OVERVIEW_DEFAULT_DAYS = 30;
export const ADMIN_WEBHOOK_LEASE_MS = 5 * 60_000;
export const ADMIN_WEBHOOK_MAX_ATTEMPTS = 5;

const utc = z.iso.datetime({ offset: false });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const flag = z.enum(["true", "false"]);
const providerId = z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/u);
const webhookEventType = z.string().regex(/^[A-Z][A-Z0-9._]{0,254}$/u);
const failureCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,64}$/u);
const booleanQuery = flag.transform((value) => value === "true");

function dateRangeIssue(
  value: { from?: string; to?: string },
  ctx: z.RefinementCtx,
  path: (string | number)[] = ["from"],
) {
  if (
    Boolean(value.from) !== Boolean(value.to) ||
    (value.from &&
      value.to &&
      (Date.parse(value.from) >= Date.parse(value.to) ||
        Date.parse(value.to) - Date.parse(value.from) > 366 * 86400_000))
  )
    ctx.addIssue({ code: "custom", path, message: "Use a UTC date range of at most 366 days." });
}

const listBase = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  from: utc.optional(),
  to: utc.optional(),
});

function withDates<T extends z.ZodRawShape>(shape: T) {
  return listBase
    .extend(shape)
    .strict()
    .superRefine((value, ctx) => dateRangeIssue(value, ctx));
}

export const AdminOwnerSchema = z.object({
  id: AdminResourceIdSchema,
  name: z.string().max(200).nullable(),
  email: z.string().email().max(320),
});
export type AdminOwner = z.infer<typeof AdminOwnerSchema>;

export const AdminPageSchema = z.object({
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
});

export const AdminOverviewQuerySchema = z
  .object({
    from: utc.optional(),
    to: utc.optional(),
  })
  .strict()
  .superRefine((value, ctx) => dateRangeIssue(value, ctx));
export type AdminOverviewQuery = z.infer<typeof AdminOverviewQuerySchema>;

export const AdminActivityQuerySchema = withDates({
  highRisk: booleanQuery.optional(),
});
export type AdminActivityQuery = z.infer<typeof AdminActivityQuerySchema>;

export const AdminUserQuerySchema = withDates({
  q: z.string().trim().max(200).optional(),
  verified: booleanQuery.optional(),
  autonomy: booleanQuery.optional(),
  disabled: booleanQuery.optional(),
  hasActiveMandate: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminUserQuery = z.infer<typeof AdminUserQuerySchema>;

export const AdminUserSessionQuerySchema = listBase
  .omit({ from: true, to: true })
  .extend({ live: booleanQuery.optional() })
  .strict();
export type AdminUserSessionQuery = z.infer<typeof AdminUserSessionQuerySchema>;

export const AdminNoteQuerySchema = listBase.omit({ from: true, to: true }).strict();
export type AdminNoteQuery = z.infer<typeof AdminNoteQuerySchema>;

export const AdminMandateQuerySchema = withDates({
  q: z.string().trim().max(200).optional(),
  userId: AdminResourceIdSchema.optional(),
  status: z.enum(MANDATE_STATUSES).optional(),
  effectiveExpired: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminMandateQuery = z.infer<typeof AdminMandateQuerySchema>;

export const AdminMandateVersionQuerySchema = listBase.omit({ from: true, to: true }).strict();

export const AdminProposalQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  mandateId: AdminResourceIdSchema.optional(),
  status: z.enum(PROPOSAL_STATUSES).optional(),
  decision: z.enum(POLICY_DECISIONS).optional(),
  source: z.string().trim().min(1).max(64).optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminProposalQuery = z.infer<typeof AdminProposalQuerySchema>;

export const AdminProposalDecisionQuerySchema = listBase.omit({ from: true, to: true }).strict();

export const AdminApprovalQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  proposalId: AdminResourceIdSchema.optional(),
  decision: z.enum(ADMIN_APPROVAL_DECISIONS).optional(),
  effectiveExpired: booleanQuery.optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["expiresAt", "createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminApprovalQuery = z.infer<typeof AdminApprovalQuerySchema>;

export const AdminOrderQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  proposalId: AdminResourceIdSchema.optional(),
  status: z.enum(ADMIN_PAYMENT_STATUSES).optional(),
  paypalOrderId: providerId.optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminOrderQuery = z.infer<typeof AdminOrderQuerySchema>;

export const AdminPaymentQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  mandateId: AdminResourceIdSchema.optional(),
  proposalId: AdminResourceIdSchema.optional(),
  status: z.enum(ADMIN_PAYMENT_STATUSES).optional(),
  paypalCaptureId: providerId.optional(),
  refundState: z.enum(["none", "pending", "refunded"]).optional(),
  amountMin: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  amountMax: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  dateBasis: z.enum(["created", "captured"]).optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["createdAt", "capturedAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
}).superRefine((value, ctx) => {
  if (
    value.amountMin !== undefined &&
    value.amountMax !== undefined &&
    value.amountMin > value.amountMax
  )
    ctx.addIssue({ code: "custom", message: "Amount minimum cannot exceed maximum." });
  if (value.dateBasis === "captured" && value.sort === "createdAt")
    ctx.addIssue({ code: "custom", message: "Captured-date views sort by capture time." });
});
export type AdminPaymentQuery = z.infer<typeof AdminPaymentQuerySchema>;

export const AdminRefundQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  paymentId: AdminResourceIdSchema.optional(),
  status: z.enum(ADMIN_REFUND_STATUSES).optional(),
  paypalRefundId: providerId.optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminRefundQuery = z.infer<typeof AdminRefundQuerySchema>;

export const AdminWebhookQuerySchema = withDates({
  providerEventId: providerId.optional(),
  eventType: webhookEventType.optional(),
  status: z.enum(ADMIN_WEBHOOK_STATUSES).optional(),
  retryEligible: booleanQuery.optional(),
  stale: booleanQuery.optional(),
  exhausted: booleanQuery.optional(),
  sort: z.enum(["receivedAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminWebhookQuery = z.infer<typeof AdminWebhookQuerySchema>;

export const AdminDomainAuditQuerySchema = withDates({
  userId: AdminResourceIdSchema.optional(),
  eventType: z.enum(ADMIN_DOMAIN_EVENT_TYPES).optional(),
  entityType: z.enum(ADMIN_DOMAIN_ENTITY_TYPES).optional(),
  entityId: AdminResourceIdSchema.optional(),
  includeSamples: booleanQuery.optional(),
  sort: z.enum(["createdAt"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});
export type AdminDomainAuditQuery = z.infer<typeof AdminDomainAuditQuerySchema>;

export const AdminProductSchema = z.object({
  id: AdminResourceIdSchema,
  source: z.string().min(1).max(64),
  externalId: z.string().min(1).max(255),
  title: z.string().min(1).max(500),
  brand: z.string().max(200).nullable(),
  category: z.string().max(200).nullable(),
  condition: z.enum(ADMIN_PRODUCT_CONDITIONS),
  merchant: z.string().min(1).max(255),
  priceMinor: money,
  currency: z.literal("USD"),
  capturedAt: utc,
});
export type AdminProduct = z.infer<typeof AdminProductSchema>;

export const AdminSpendProjectionSchema = z
  .object({
    currency: z.literal("USD").optional(),
    confirmedDailyMinor: money.optional(),
    confirmedWeeklyMinor: money.optional(),
    confirmedMonthlyMinor: money.optional(),
    globalAutonomousPurchasingEnabled: z.boolean().optional(),
  })
  .strict();
export type AdminSpendProjection = z.infer<typeof AdminSpendProjectionSchema>;

export const AdminPolicyDecisionSchema = z.object({
  id: AdminResourceIdSchema,
  proposalId: AdminResourceIdSchema,
  mandateVersionId: AdminResourceIdSchema,
  decision: z.enum(POLICY_DECISIONS),
  reasonCodes: z.array(z.enum(ADMIN_POLICY_REASON_CODES)),
  rules: z.custom<CanonicalMandate | null>(),
  spend: AdminSpendProjectionSchema.nullable(),
  createdAt: utc,
});
export type AdminPolicyDecision = z.infer<typeof AdminPolicyDecisionSchema>;

export const AdminReservationSchema = z.object({
  id: AdminResourceIdSchema,
  proposalId: AdminResourceIdSchema,
  mandateId: AdminResourceIdSchema,
  mandateVersionId: AdminResourceIdSchema,
  amountMinor: money,
  currency: z.literal("USD"),
  window: z.enum(ADMIN_RESERVATION_WINDOWS),
  windowStart: utc,
  windowEnd: utc,
  status: z.enum(ADMIN_RESERVATION_STATUSES),
  expiresAt: utc,
  releasedAt: utc.nullable(),
  consumedAt: utc.nullable(),
  isSample: z.boolean(),
});
export type AdminReservation = z.infer<typeof AdminReservationSchema>;

export const AdminEntityCapabilitySchema = z.object({
  action: z.enum(ADMIN_ENTITY_ACTIONS),
  allowed: z.boolean(),
  reason: z.string().max(200).nullable(),
});
export type AdminEntityCapability = z.infer<typeof AdminEntityCapabilitySchema>;

export const AdminUserSchema = z.object({
  id: AdminResourceIdSchema,
  name: z.string().max(200).nullable(),
  email: z.string().email().max(320),
  emailVerified: z.boolean(),
  autonomousPurchasingEnabled: z.boolean(),
  createdAt: utc,
  updatedAt: utc,
  accessVersion: z.number().int().nonnegative(),
  activeMandateCount: z.number().int().nonnegative(),
  proposalCount: z.number().int().nonnegative(),
  capturedGrossMinor: money,
  lastActivityAt: utc,
  lastActivityBasis: z.literal("observed_activity_proxy"),
  accessStatus: z.enum(["enabled", "disabled"]),
  accessStatusReason: z.string().max(255).nullable(),
  disabledAt: utc.nullable(),
  capabilities: z.array(AdminEntityCapabilitySchema).max(16),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUserSessionSchema = z.object({
  id: AdminResourceIdSchema,
  createdAt: utc,
  updatedAt: utc,
  expiresAt: utc,
  isCurrent: z.boolean(),
});
export type AdminUserSession = z.infer<typeof AdminUserSessionSchema>;

export const AdminNoteSchema = z.object({
  id: z.uuid(),
  userId: AdminResourceIdSchema,
  body: z.string().min(1).max(2000),
  authorPrincipalId: z.uuid(),
  authorName: z.string().max(200).nullable(),
  createdAt: utc,
});
export type AdminNote = z.infer<typeof AdminNoteSchema>;

const mutationBase = {
  reason: AdminReasonSchema,
  confirmation: z.literal(true),
  requestKey: AdminTraceIdSchema,
};
export const AdminUserAccessMutationSchema = z
  .object({
    ...mutationBase,
    expectedUpdatedAt: utc,
    expectedAccessVersion: z.number().int().nonnegative(),
    typedConfirmation: AdminResourceIdSchema.optional(),
  })
  .strict();
export type AdminUserAccessMutation = z.infer<typeof AdminUserAccessMutationSchema>;
export const AdminUserDisableMutationSchema = AdminUserAccessMutationSchema.extend({
  typedConfirmation: AdminResourceIdSchema,
}).strict();
export const AdminMandateLifecycleMutationSchema = z
  .object({
    ...mutationBase,
    expectedVersion: z.number().int().positive(),
    expectedStatus: z.enum(MANDATE_STATUSES),
    typedConfirmation: AdminResourceIdSchema,
  })
  .strict();
export type AdminMandateLifecycleMutation = z.infer<typeof AdminMandateLifecycleMutationSchema>;
export const AdminProposalReevaluateMutationSchema = z
  .object({
    ...mutationBase,
    expectedStatus: z.enum(PROPOSAL_STATUSES),
    expectedUpdatedAt: utc,
  })
  .strict();
export type AdminProposalReevaluateMutation = z.infer<typeof AdminProposalReevaluateMutationSchema>;
export const AdminNoteCreateSchema = z
  .object({
    reason: AdminReasonSchema,
    requestKey: AdminTraceIdSchema,
    body: AdminNoteBodySchema,
  })
  .strict();
export type AdminNoteCreate = z.infer<typeof AdminNoteCreateSchema>;

export const AdminMandateSchema = z.object({
  id: AdminResourceIdSchema,
  owner: AdminOwnerSchema,
  title: z.string().min(1).max(200),
  status: z.enum(MANDATE_STATUSES),
  version: z.number().int().positive(),
  activeVersionId: AdminResourceIdSchema.nullable(),
  currency: z.literal("USD"),
  autoSpendLimitMinor: money,
  transactionLimitMinor: money,
  dailyLimitMinor: money.nullable(),
  weeklyLimitMinor: money.nullable(),
  monthlyLimitMinor: money.nullable(),
  spendTimeZone: z.literal("UTC"),
  startsAt: utc,
  expiresAt: utc,
  effectiveExpired: z.boolean(),
  rules: z.custom<CanonicalMandate | null>(),
  relatedProposalCount: z.number().int().nonnegative(),
  createdAt: utc,
  updatedAt: utc,
  capabilities: z.array(AdminEntityCapabilitySchema).max(16),
});
export type AdminMandate = z.infer<typeof AdminMandateSchema>;

export const AdminMandateVersionSchema = z.object({
  id: AdminResourceIdSchema,
  mandateId: AdminResourceIdSchema,
  version: z.number().int().positive(),
  title: z.string().min(1).max(200),
  currency: z.literal("USD"),
  autoSpendLimitMinor: money,
  transactionLimitMinor: money,
  dailyLimitMinor: money.nullable(),
  weeklyLimitMinor: money.nullable(),
  monthlyLimitMinor: money.nullable(),
  spendTimeZone: z.literal("UTC"),
  startsAt: utc,
  expiresAt: utc,
  rules: z.custom<CanonicalMandate | null>(),
  createdAt: utc,
});
export type AdminMandateVersion = z.infer<typeof AdminMandateVersionSchema>;

export const AdminProposalSchema = z.object({
  id: AdminResourceIdSchema,
  owner: AdminOwnerSchema,
  mandateId: AdminResourceIdSchema,
  mandateVersionId: AdminResourceIdSchema,
  product: AdminProductSchema,
  quantity: z.number().int().positive(),
  subtotalMinor: money,
  shippingMinor: money,
  taxMinor: money,
  totalMinor: money,
  currency: z.literal("USD"),
  status: z.enum(PROPOSAL_STATUSES),
  expiresAt: utc.nullable(),
  latestDecision: AdminPolicyDecisionSchema.nullable(),
  approvalId: AdminResourceIdSchema.nullable(),
  paymentId: AdminResourceIdSchema.nullable(),
  reservationId: AdminResourceIdSchema.nullable(),
  checkoutEligible: z.boolean(),
  checkoutEligibilityNote: z.string(),
  isSample: z.boolean(),
  createdAt: utc,
  updatedAt: utc,
  capabilities: z.array(AdminEntityCapabilitySchema).max(16),
});
export type AdminProposal = z.infer<typeof AdminProposalSchema>;

export const AdminApprovalSchema = z.object({
  id: AdminResourceIdSchema,
  owner: AdminOwnerSchema,
  proposalId: AdminResourceIdSchema,
  decision: z.enum(ADMIN_APPROVAL_DECISIONS),
  expiresAt: utc,
  decidedAt: utc.nullable(),
  effectiveExpired: z.boolean(),
  isSample: z.boolean(),
  proposalStatus: z.enum(PROPOSAL_STATUSES),
  proposalTotalMinor: money,
  currency: z.literal("USD"),
  productTitle: z.string().min(1).max(500),
  createdAt: utc,
  updatedAt: utc,
});
export type AdminApproval = z.infer<typeof AdminApprovalSchema>;

export const AdminOrderSchema = z.object({
  id: AdminResourceIdSchema,
  paymentId: AdminResourceIdSchema,
  proposalId: AdminResourceIdSchema,
  owner: AdminOwnerSchema,
  paypalOrderId: z.string().max(255).nullable(),
  amountMinor: money,
  currency: z.literal("USD"),
  paymentStatus: z.enum(ADMIN_PAYMENT_STATUSES),
  proposalStatus: z.enum(PROPOSAL_STATUSES),
  providerApprovalKnown: z.boolean(),
  paypalCaptureId: z.string().max(255).nullable(),
  capturedAt: utc.nullable(),
  reconciliation: z.enum([
    "LOCAL_ONLY",
    "ORDER_CREATED",
    "APPROVED_UNCAPTURED",
    "CAPTURE_UNKNOWN",
    "SETTLED",
    "FAILED",
    "INDETERMINATE",
  ]),
  isSample: z.boolean(),
  createdAt: utc,
  updatedAt: utc,
});
export type AdminOrder = z.infer<typeof AdminOrderSchema>;

export const AdminPaymentSchema = AdminOrderSchema.extend({
  mandateId: AdminResourceIdSchema,
  failureCode: failureCode.nullable(),
  refundedMinor: money,
  refundCount: z.number().int().nonnegative(),
  remainingRefundableMinor: money,
  refundState: z.enum(["none", "pending", "refunded"]),
});
export type AdminPayment = z.infer<typeof AdminPaymentSchema>;

export const AdminRefundSchema = z.object({
  id: AdminResourceIdSchema,
  invoiceId: AdminResourceIdSchema,
  owner: AdminOwnerSchema,
  paymentId: AdminResourceIdSchema,
  amountMinor: money,
  currency: z.literal("USD"),
  status: z.enum(ADMIN_REFUND_STATUSES),
  paypalRefundId: z.string().max(255).nullable(),
  createdAt: utc,
  settledAt: utc.nullable(),
  reason: z.string().max(255).nullable(),
  failureCode: failureCode.nullable(),
  kind: z.enum(["FULL", "PARTIAL"]),
  isSample: z.boolean(),
  updatedAt: utc,
});
export type AdminRefund = z.infer<typeof AdminRefundSchema>;

export const AdminWebhookSchema = z.object({
  id: AdminResourceIdSchema,
  providerEventId: z.string().min(1).max(255),
  eventType: z.string().min(1).max(255),
  signatureVerified: z.boolean(),
  status: z.enum(ADMIN_WEBHOOK_STATUSES),
  attempts: z.number().int().nonnegative(),
  receivedAt: utc,
  processedAt: utc.nullable(),
  updatedAt: utc,
  nextAttemptAt: utc.nullable(),
  leaseExpiresAt: utc.nullable(),
  stale: z.boolean(),
  retryEligible: z.boolean(),
  exhausted: z.boolean(),
  errorCode: z.enum(ADMIN_WEBHOOK_ERROR_CODES).nullable(),
  paymentId: AdminResourceIdSchema.nullable(),
  orderId: AdminResourceIdSchema.nullable(),
  refundId: AdminResourceIdSchema.nullable(),
});
export type AdminWebhook = z.infer<typeof AdminWebhookSchema>;

export const AdminDomainAuditSchema = z.object({
  id: AdminResourceIdSchema,
  userId: AdminResourceIdSchema,
  eventType: z.enum(ADMIN_DOMAIN_EVENT_TYPES),
  entityType: z.enum(ADMIN_DOMAIN_ENTITY_TYPES),
  entityId: AdminResourceIdSchema,
  createdAt: utc,
  isSample: z.boolean(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AdminDomainAudit = z.infer<typeof AdminDomainAuditSchema>;

export const AdminActivityEventSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.enum(["admin", "domain"]),
  title: z.string().min(1).max(200),
  at: utc,
  status: z.string().min(1).max(64),
  highRisk: z.boolean(),
  actorUserId: AdminResourceIdSchema.nullable(),
  targetType: z.string().min(1).max(64),
  targetId: z.string().min(1).max(255),
  href: z
    .object({
      resource: z.enum([
        "users",
        "mandates",
        "proposals",
        "approvals",
        "orders",
        "payments",
        "refunds",
        "webhooks",
        "audit",
      ]),
      id: AdminResourceIdSchema,
    })
    .nullable(),
});
export type AdminActivityEvent = z.infer<typeof AdminActivityEventSchema>;

export const AdminMetricSchema = z.object({
  value: z.number().finite().max(Number.MAX_SAFE_INTEGER).nullable(),
  availability: z.enum(["available", "unavailable"]),
  reason: z.string().max(300).nullable(),
  definition: z.string().min(1).max(500),
  unit: z.enum(["count", "minor"]).optional(),
  series: z
    .array(z.object({ key: z.string().min(1).max(64), value: money }))
    .max(400)
    .optional(),
});
export type AdminMetric = z.infer<typeof AdminMetricSchema>;

export const AdminOverviewSchema = z.object({
  asOf: utc,
  range: z.object({ from: utc, to: utc }),
  currency: z.literal("USD"),
  metrics: z.record(z.string(), AdminMetricSchema),
  controls: z.record(z.string(), AdminMetricSchema),
  warnings: z.array(z.string().min(1).max(300)),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

const sensitiveText =
  /(?:\b(?:password|passwd|secret|token|authorization|cookie|api[_ -]?key|client[_ -]?secret)\s*[:=]|\bbearer\s+\S+|-----BEGIN|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk|pk|re)_[A-Za-z0-9_-]{12,}|https?:\/\/\S*[?@]|\b[A-Za-z0-9_+/=-]{48,}\b)/iu;

export function normalizeFailureCode(value: string | null | undefined): string | null {
  if (!value) return null;
  return failureCode.safeParse(value).success ? value : "UNKNOWN";
}

export function safeAdminText(value: string | null | undefined, max = 255): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed) || sensitiveText.test(trimmed))
    return null;
  return trimmed;
}

export function webhookErrorCode(lastError: string | null, exhausted: boolean) {
  if (exhausted) return "RECOVERY_EXHAUSTED" as const;
  if (!lastError) return null;
  if (/timeout/iu.test(lastError)) return "WEBHOOK_TIMEOUT" as const;
  if (/signature/iu.test(lastError)) return "SIGNATURE_INVALID" as const;
  if (/pending|unknown outcome/iu.test(lastError)) return "PROVIDER_PENDING" as const;
  return "WEBHOOK_PROCESSING_FAILED" as const;
}

export function parseCanonicalRules(value: unknown): CanonicalMandate | null {
  const parsed = CanonicalMandateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseReasonCodes(value: unknown): (typeof ADMIN_POLICY_REASON_CODES)[number][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = z.enum(ADMIN_POLICY_REASON_CODES).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseSpendProjection(value: unknown): AdminSpendProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const confirmed =
    source.confirmed && typeof source.confirmed === "object" && !Array.isArray(source.confirmed)
      ? (source.confirmed as Record<string, unknown>)
      : {};
  const parsed = AdminSpendProjectionSchema.safeParse({
    currency: source.currency === "USD" ? "USD" : undefined,
    confirmedDailyMinor: confirmed.daily,
    confirmedWeeklyMinor: confirmed.weekly,
    confirmedMonthlyMinor: confirmed.monthly,
    globalAutonomousPurchasingEnabled:
      typeof source.globalAutonomousPurchasingEnabled === "boolean"
        ? source.globalAutonomousPurchasingEnabled
        : undefined,
  });
  return parsed.success ? parsed.data : null;
}

const domainFactKeys = new Set([
  "decision",
  "amount",
  "amountMinor",
  "currency",
  "status",
  "source",
  "mode",
  "previous",
  "next",
  "version",
  "mandateId",
  "mandateVersionId",
  "proposalId",
  "paymentId",
  "refundId",
  "productSnapshotId",
  "total",
  "failureCode",
  "reasonCode",
  "category",
  "capturedAt",
  "settledAt",
  "from",
  "to",
  "aiReason",
]);

export function parseDomainFacts(value: unknown): AdminDomainAudit["facts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const facts: AdminDomainAudit["facts"] = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!domainFactKeys.has(key)) continue;
    if (typeof entry === "string") {
      const safe = safeAdminText(entry, 200);
      if (safe) facts[key] = safe;
    } else if (
      typeof entry === "number" &&
      Number.isFinite(entry) &&
      Math.abs(entry) <= Number.MAX_SAFE_INTEGER
    )
      facts[key] = entry;
    else if (typeof entry === "boolean") facts[key] = entry;
    else if (entry === null) facts[key] = null;
  }
  return facts;
}

export function paymentReconciliation(input: {
  status: (typeof ADMIN_PAYMENT_STATUSES)[number];
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  capturedAt: string | null;
}): AdminOrder["reconciliation"] {
  if (["DENIED", "FAILED"].includes(input.status)) return "FAILED";
  if (
    CAPTURED_PAYMENT_STATUSES.includes(
      input.status as (typeof CAPTURED_PAYMENT_STATUSES)[number],
    ) &&
    input.paypalCaptureId &&
    input.capturedAt
  )
    return "SETTLED";
  if (input.status === "CAPTURE_PENDING") return "CAPTURE_UNKNOWN";
  if (input.status === "APPROVED" && input.paypalOrderId) return "APPROVED_UNCAPTURED";
  if (input.status === "CREATED" && input.paypalOrderId) return "ORDER_CREATED";
  if (input.status === "CREATED") return "LOCAL_ONLY";
  return "INDETERMINATE";
}

export function checkoutEligibility(input: {
  source: string;
  isSample: boolean;
  status: string;
  expiresAt: string | null;
  asOf: Date;
}) {
  const eligible =
    input.source === "demo" &&
    !input.isSample &&
    ["AUTHORIZED", "PAYPAL_ORDER_CREATED", "PAYMENT_PENDING"].includes(input.status) &&
    (!input.expiresAt || Date.parse(input.expiresAt) > input.asOf.getTime());
  return {
    checkoutEligible: eligible,
    checkoutEligibilityNote:
      "Recorded demo-checkout eligibility only. This does not authorize payment execution.",
  };
}

function pick<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseAdminOwner(value: unknown) {
  return pick(AdminOwnerSchema, value);
}
export function parseAdminUser(value: unknown) {
  return pick(AdminUserSchema, value);
}
export function parseAdminUserSession(value: unknown) {
  return pick(AdminUserSessionSchema, value);
}
export function parseAdminNote(value: unknown) {
  return pick(AdminNoteSchema, value);
}
export function parseAdminProduct(value: unknown) {
  return pick(AdminProductSchema, value);
}
export function parseAdminMandate(value: unknown) {
  const parsed = AdminMandateSchema.safeParse({
    ...(value && typeof value === "object" ? value : {}),
    rules:
      value && typeof value === "object" && "rules" in value
        ? parseCanonicalRules((value as { rules: unknown }).rules)
        : null,
  });
  return parsed.success ? parsed.data : null;
}
export function parseAdminMandateVersion(value: unknown) {
  const parsed = AdminMandateVersionSchema.safeParse({
    ...(value && typeof value === "object" ? value : {}),
    rules:
      value && typeof value === "object" && "rules" in value
        ? parseCanonicalRules((value as { rules: unknown }).rules)
        : null,
  });
  return parsed.success ? parsed.data : null;
}
export function parseAdminPolicyDecision(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const parsed = AdminPolicyDecisionSchema.safeParse({
    ...source,
    reasonCodes: parseReasonCodes(source.reasonCodes),
    rules: parseCanonicalRules(source.rules),
    spend: parseSpendProjection(source.spend),
  });
  return parsed.success ? parsed.data : null;
}
export function parseAdminReservation(value: unknown) {
  return pick(AdminReservationSchema, value);
}
export function parseAdminProposal(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const parsed = AdminProposalSchema.safeParse({
    ...source,
    owner: parseAdminOwner(source.owner),
    product: parseAdminProduct(source.product),
    latestDecision: source.latestDecision ? parseAdminPolicyDecision(source.latestDecision) : null,
  });
  return parsed.success ? parsed.data : null;
}
export function parseAdminApproval(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return pick(AdminApprovalSchema, { ...source, owner: parseAdminOwner(source.owner) });
}
export function parseAdminOrder(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return pick(AdminOrderSchema, { ...source, owner: parseAdminOwner(source.owner) });
}
export function parseAdminPayment(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return pick(AdminPaymentSchema, {
    ...source,
    owner: parseAdminOwner(source.owner),
    failureCode: normalizeFailureCode(
      typeof source.failureCode === "string" ? source.failureCode : null,
    ),
  });
}
export function parseAdminRefund(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return pick(AdminRefundSchema, {
    ...source,
    owner: parseAdminOwner(source.owner),
    reason: safeAdminText(typeof source.reason === "string" ? source.reason : null),
    failureCode: normalizeFailureCode(
      typeof source.failureCode === "string" ? source.failureCode : null,
    ),
  });
}
export function parseAdminWebhook(value: unknown) {
  return pick(AdminWebhookSchema, value);
}
export function parseAdminDomainAudit(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return pick(AdminDomainAuditSchema, { ...source, facts: parseDomainFacts(source.facts) });
}
export function parseAdminActivityEvent(value: unknown) {
  return pick(AdminActivityEventSchema, value);
}
export function parseAdminOverview(value: unknown) {
  return pick(AdminOverviewSchema, value);
}

export function parseAdminPage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const page = value as { limit?: unknown; nextCursor?: unknown };
  if (
    !Number.isInteger(page.limit) ||
    typeof page.limit !== "number" ||
    page.limit < 1 ||
    page.limit > 100 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" ||
        page.nextCursor.length > 2048 ||
        page.nextCursor === ""))
  )
    return null;
  return { limit: page.limit, nextCursor: page.nextCursor as string | null };
}

export function parseAdminList<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
  maximum = 100,
): { data: T[]; page: { limit: number; nextCursor: string | null } } | null {
  if (!value || typeof value !== "object" || !("data" in value) || !("page" in value)) return null;
  if (!Array.isArray(value.data) || value.data.length > maximum) return null;
  const page = parseAdminPage(value.page);
  if (!page || value.data.length > page.limit) return null;
  const data = value.data.map(parseItem);
  if (data.some((item) => item === null)) return null;
  return { data: data as T[], page };
}

export function parseAdminDetail<T>(value: unknown, parseItem: (item: unknown) => T | null) {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = parseItem(value.data);
  return data ? { data } : null;
}

export function parseAdminNullableDetail<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
) {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  if (value.data === null) return { data: null };
  const data = parseItem(value.data);
  return data ? { data } : null;
}

export function parseAdminMutation<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): { data: T; changed: boolean; pending: boolean; actionId: string } | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const data = parseItem(source.data);
  if (
    !data ||
    typeof source.changed !== "boolean" ||
    typeof source.pending !== "boolean" ||
    !AdminTraceIdSchema.safeParse(source.actionId).success
  )
    return null;
  return {
    data,
    changed: source.changed,
    pending: source.pending,
    actionId: AdminTraceIdSchema.parse(source.actionId),
  };
}

export const ADMIN_EXPORT_COLUMNS = {
  users: [
    "id",
    "name",
    "email",
    "emailVerified",
    "autonomousPurchasingEnabled",
    "accessStatus",
    "activeMandateCount",
    "proposalCount",
    "capturedGrossMinor",
    "lastActivityAt",
    "createdAt",
  ],
  mandates: [
    "id",
    "ownerId",
    "ownerEmail",
    "title",
    "status",
    "version",
    "transactionLimitMinor",
    "effectiveExpired",
    "startsAt",
    "expiresAt",
    "createdAt",
  ],
  proposals: [
    "id",
    "ownerId",
    "ownerEmail",
    "mandateId",
    "status",
    "decision",
    "totalMinor",
    "currency",
    "isSample",
    "createdAt",
  ],
  approvals: [
    "id",
    "ownerId",
    "ownerEmail",
    "proposalId",
    "decision",
    "effectiveExpired",
    "expiresAt",
    "decidedAt",
    "createdAt",
  ],
  orders: [
    "id",
    "ownerId",
    "ownerEmail",
    "proposalId",
    "paypalOrderId",
    "amountMinor",
    "paymentStatus",
    "reconciliation",
    "createdAt",
  ],
  payments: [
    "id",
    "ownerId",
    "ownerEmail",
    "mandateId",
    "proposalId",
    "paypalCaptureId",
    "amountMinor",
    "paymentStatus",
    "refundState",
    "capturedAt",
    "createdAt",
  ],
  refunds: [
    "id",
    "ownerId",
    "ownerEmail",
    "paymentId",
    "amountMinor",
    "kind",
    "status",
    "paypalRefundId",
    "settledAt",
    "createdAt",
  ],
  webhooks: [
    "id",
    "providerEventId",
    "eventType",
    "signatureVerified",
    "status",
    "attempts",
    "stale",
    "retryEligible",
    "exhausted",
    "errorCode",
    "receivedAt",
    "processedAt",
  ],
  audit: ["id", "action", "targetType", "targetId", "result", "actorUserId", "createdAt"],
} as const;
export type AdminExportResource = keyof typeof ADMIN_EXPORT_COLUMNS;

export function csvCell(value: string | number | boolean | null | undefined) {
  const text =
    value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  const neutralized = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${neutralized.replaceAll('"', '""').replaceAll(/[\r\n]+/gu, " ")}"`;
}

export function buildAdminCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, string | number | boolean | null | undefined>>,
  truncated: boolean,
) {
  const header = columns.map(csvCell).join(",");
  const body = rows
    .map((row) => columns.map((column) => csvCell(row[column])).join(","))
    .join("\r\n");
  const notice = truncated ? `\r\n${csvCell(`TRUNCATED_AT_${ADMIN_CSV_MAX_ROWS}`)}` : "";
  return `${header}\r\n${body}${notice}\r\n`;
}

export function parseAdminCsv(text: string, columns: readonly string[]) {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .trimEnd()
    .split(/\r?\n/u);
  if (!lines[0]) return null;
  const header = parseCsvLine(lines[0]);
  if (header.length !== columns.length || columns.some((column, index) => header[index] !== column))
    return null;
  if (lines.length - 1 > ADMIN_CSV_MAX_ROWS + 1) return null;
  return { columns: header, rowCount: Math.max(0, lines.length - 1) };
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

export { AdminResourceIdSchema, AdminTraceIdSchema };
