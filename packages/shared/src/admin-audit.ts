import { z } from "zod";

export const ADMIN_AUDIT_ACTIONS = [
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
] as const;
export const ADMIN_AUDIT_TARGETS = [
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
] as const;
export const ADMIN_AUDIT_RESULTS = ["PENDING", "SUCCESS", "FAILURE"] as const;
export const ADMIN_AUDIT_ERROR_CODES = [
  "ADMIN_SIGN_IN_REJECTED",
  "ADMIN_UNAUTHORIZED",
  "ADMIN_FORBIDDEN",
  "ADMIN_REAUTH_REQUIRED",
  "ADMIN_INVALID_REQUEST",
  "ADMIN_RATE_LIMITED",
  "ADMIN_UNAVAILABLE",
  "INVALID_STATE",
  "CONFLICT",
  "TARGET_NOT_FOUND",
  "PROVIDER_PENDING",
  "PROVIDER_UNAVAILABLE",
  "DOMAIN_REJECTED",
] as const;
export const ADMIN_SETTING_KEYS = [
  "platform.maintenanceMode",
  "platform.registrationEnabled",
  "agent.enabled",
  "agent.proposalCreationEnabled",
  "discovery.demoCatalogEnabled",
  "discovery.channel3Enabled",
  "payments.checkoutEnabled",
  "payments.refundsEnabled",
  "payments.autonomyEnabledGlobally",
  "workers.webhookProcessingEnabled",
] as const;
export const AdminAuditActionSchema = z.enum(ADMIN_AUDIT_ACTIONS);
export const AdminAuditTargetSchema = z.enum(ADMIN_AUDIT_TARGETS);
export const AdminAuditResultSchema = z.enum(ADMIN_AUDIT_RESULTS);
export const AdminAuditErrorCodeSchema = z.enum(ADMIN_AUDIT_ERROR_CODES);
export const AdminResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/u);
export const AdminTraceIdSchema = z.uuid();
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;
export type AdminAuditTarget = z.infer<typeof AdminAuditTargetSchema>;
export type AdminAuditResult = z.infer<typeof AdminAuditResultSchema>;

export function isAdminActionResultValid(action: AdminAuditAction, result: AdminAuditResult) {
  if (action.endsWith("_SUCCEEDED")) return result === "SUCCESS";
  if (action.endsWith("_FAILED")) return result === "FAILURE";
  return true;
}

// Reasons are operator explanations, not a place to paste credentials or URLs
// carrying tokens. Unknown free text cannot be classified perfectly; keep the
// collector bounded and reject recognizable credential material without echoing it.
const sensitiveText =
  /(?:\b(?:password|passwd|secret|token|authorization|cookie|api[_ -]?key|client[_ -]?secret)\s*[:=]|\bbearer\s+\S+|-----BEGIN|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk|pk|re)_[A-Za-z0-9_-]{12,}|https?:\/\/\S*[?@]|\b[A-Za-z0-9_+/=-]{48,}\b)/iu;
export const AdminReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value) && !sensitiveText.test(value),
    "Provide a reason without credential material.",
  );
export function requireAdminReason(value: unknown) {
  return AdminReasonSchema.parse(value);
}

const date = z.iso.datetime({ offset: false });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.literal("USD");
const summaries = {
  ADMIN_AUTH: z.object({}),
  ADMIN_SESSION: z.object({
    expiresAt: date.optional(),
    freshAuthUntil: date.optional(),
    revoked: z.boolean().optional(),
  }),
  USER: z.object({
    emailVerified: z.boolean().optional(),
    autonomousPurchasingEnabled: z.boolean().optional(),
    disabledAt: date.nullable().optional(),
  }),
  MANDATE: z.object({
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "EXPIRED", "REVOKED"]).optional(),
    version: count.optional(),
    currency: currency.optional(),
  }),
  PROPOSAL: z.object({
    status: z
      .enum([
        "DRAFT",
        "PROPOSED",
        "POLICY_CHECKED",
        "BLOCKED",
        "AWAITING_APPROVAL",
        "APPROVED",
        "AUTHORIZED",
        "PAYPAL_ORDER_CREATED",
        "PAYMENT_PENDING",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "EXPIRED",
      ])
      .optional(),
    amountMinor: count.optional(),
    currency: currency.optional(),
    isSample: z.boolean().optional(),
  }),
  APPROVAL: z.object({
    decision: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]).optional(),
    expiresAt: date.optional(),
  }),
  PAYMENT: z.object({
    status: z
      .enum([
        "CREATED",
        "APPROVED",
        "CAPTURE_PENDING",
        "COMPLETED",
        "DENIED",
        "FAILED",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
      ])
      .optional(),
    amountMinor: count.optional(),
    currency: currency.optional(),
    isSample: z.boolean().optional(),
  }),
  REFUND: z.object({
    status: z
      .enum(["REQUESTED", "APPROVED", "SUBMITTED", "COMPLETED", "FAILED", "CANCELLED"])
      .optional(),
    amountMinor: count.optional(),
    currency: currency.optional(),
    isSample: z.boolean().optional(),
  }),
  WEBHOOK: z.object({
    status: z.enum(["RECEIVED", "PROCESSING", "PROCESSED", "FAILED", "IGNORED"]).optional(),
    signatureVerified: z.boolean().optional(),
    attempts: count.optional(),
    nextAttemptAt: date.nullable().optional(),
  }),
  PLATFORM_SETTING: z.object({
    key: z.enum(ADMIN_SETTING_KEYS).optional(),
    value: z.boolean().optional(),
    version: count.optional(),
  }),
  SYSTEM: z.object({ status: z.enum(["ready", "degraded", "unavailable", "unknown"]).optional() }),
} satisfies Record<AdminAuditTarget, z.ZodType>;
export type AdminSafeSummary = Record<string, string | number | boolean | null>;

/** Construct scalar facts only; unknown/nested fields are discarded, never serialized. */
export function buildAdminSummary(
  target: AdminAuditTarget,
  source: unknown,
): AdminSafeSummary | null {
  if (source === null || source === undefined) return null;
  return Object.fromEntries(
    Object.entries(summaries[target].parse(source) as AdminSafeSummary).filter(
      ([, value]) => value !== undefined,
    ),
  ) as AdminSafeSummary;
}
export function parseAdminTargetId(target: AdminAuditTarget, value: unknown) {
  return target === "PLATFORM_SETTING"
    ? z.enum(ADMIN_SETTING_KEYS).parse(value)
    : AdminResourceIdSchema.parse(value);
}

export const AdminAuditQuerySchema = z
  .object({
    action: AdminAuditActionSchema.optional(),
    targetType: AdminAuditTargetSchema.optional(),
    targetId: AdminResourceIdSchema.or(z.enum(ADMIN_SETTING_KEYS)).optional(),
    result: AdminAuditResultSchema.optional(),
    actorAdminId: z.uuid().optional(),
    correlationId: AdminTraceIdSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Boolean(value.from) !== Boolean(value.to) ||
      (value.from &&
        value.to &&
        (Date.parse(value.from) >= Date.parse(value.to) ||
          Date.parse(value.to) - Date.parse(value.from) > 366 * 86400_000))
    )
      ctx.addIssue({ code: "custom", message: "Use a UTC date range of at most 366 days." });
    if (value.targetId && !value.targetType)
      ctx.addIssue({ code: "custom", message: "Target ID requires target type." });
    if (value.targetType && value.targetId) {
      try {
        parseAdminTargetId(value.targetType, value.targetId);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid target." });
      }
    }
  });
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

export const ADMIN_ACTION_TARGET: Record<AdminAuditAction, AdminAuditTarget> = {
  ADMIN_LOGIN_SUCCEEDED: "ADMIN_SESSION",
  ADMIN_LOGIN_FAILED: "ADMIN_AUTH",
  ADMIN_REAUTH_SUCCEEDED: "ADMIN_SESSION",
  ADMIN_REAUTH_FAILED: "ADMIN_AUTH",
  ADMIN_LOGOUT_SUCCEEDED: "ADMIN_SESSION",
  ADMIN_USER_DISABLED: "USER",
  ADMIN_USER_ENABLED: "USER",
  ADMIN_SESSIONS_REVOKED: "USER",
  ADMIN_AUTONOMY_DISABLED: "USER",
  ADMIN_NOTE_ADDED: "USER",
  ADMIN_MANDATE_PAUSED: "MANDATE",
  ADMIN_MANDATE_REVOKED: "MANDATE",
  ADMIN_PAYMENT_RECONCILE_REQUESTED: "PAYMENT",
  ADMIN_REFUND_REQUESTED: "REFUND",
  ADMIN_WEBHOOK_RETRY_REQUESTED: "WEBHOOK",
  ADMIN_WEBHOOK_RECONCILE_REQUESTED: "WEBHOOK",
  ADMIN_FEATURE_FLAG_CHANGED: "PLATFORM_SETTING",
  ADMIN_MAINTENANCE_MODE_CHANGED: "PLATFORM_SETTING",
};

const eventFields = z.object({
  id: z.uuid(),
  actorAdminId: z.uuid().nullable(),
  actorUserId: AdminResourceIdSchema.nullable(),
  role: z.literal("ADMIN_SUPER").nullable(),
  action: AdminAuditActionSchema,
  targetType: AdminAuditTargetSchema,
  targetId: z.string(),
  reason: AdminReasonSchema,
  requestId: AdminTraceIdSchema,
  correlationId: AdminTraceIdSchema,
  actionId: z.uuid().nullable(),
  beforeSummaryJson: z.unknown(),
  afterSummaryJson: z.unknown(),
  result: AdminAuditResultSchema,
  errorCode: AdminAuditErrorCodeSchema.nullable(),
  createdAt: date,
});
export type AdminAuditEventDTO = z.infer<typeof eventFields> & {
  beforeSummaryJson: AdminSafeSummary | null;
  afterSummaryJson: AdminSafeSummary | null;
};
export function parseAdminAuditEvent(value: unknown): AdminAuditEventDTO | null {
  const parsed = eventFields.safeParse(value);
  if (!parsed.success) return null;
  try {
    const event = parsed.data;
    if (ADMIN_ACTION_TARGET[event.action] !== event.targetType) return null;
    if (!isAdminActionResultValid(event.action, event.result)) return null;
    if (
      (event.result === "SUCCESS" && event.errorCode !== null) ||
      (event.result === "FAILURE" && event.errorCode === null)
    )
      return null;
    const anonymous =
      event.actorAdminId === null && event.actorUserId === null && event.role === null;
    if (
      anonymous
        ? !["ADMIN_LOGIN_FAILED", "ADMIN_REAUTH_FAILED"].includes(event.action)
        : !event.actorAdminId || !event.actorUserId || !event.role
    )
      return null;
    return {
      ...event,
      targetId: parseAdminTargetId(event.targetType, event.targetId),
      beforeSummaryJson: buildAdminSummary(event.targetType, event.beforeSummaryJson),
      afterSummaryJson: buildAdminSummary(event.targetType, event.afterSummaryJson),
    };
  } catch {
    return null;
  }
}
