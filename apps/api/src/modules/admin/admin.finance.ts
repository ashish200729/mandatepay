import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminActionRepository,
  AdminOperationsRepository,
  isDatabaseError,
  Prisma,
  type DatabaseClient,
} from "@mandatepay/database";
import type { PayPalClient } from "@mandatepay/paypal";
import {
  AdminPaymentReconcileMutationSchema,
  AdminPaymentRefundMutationSchema,
  AdminRefundRefreshMutationSchema,
  AdminResourceIdSchema,
  AdminWebhookReconcileMutationSchema,
  AdminWebhookRetryMutationSchema,
  type AdminAuditAction,
} from "@mandatepay/shared";
import {
  PaymentServiceError,
  reconcilePaypalOrder,
  type PaymentServiceContext,
} from "../../services/payments.js";
import {
  RefundServiceError,
  reconcileRefundStatus,
  refundPayment,
} from "../../services/refunds.js";
import { PlatformControlDenied } from "../../services/platform-controls.js";
import { PrismaWebhookInboxStore, createPayPalWebhookService } from "../../services/webhooks.js";
import {
  WEBHOOK_RECOVERY_BASE_DELAY_MS,
  WEBHOOK_RECOVERY_LEASE_MS,
  WEBHOOK_RECOVERY_MAX_ATTEMPTS,
  WEBHOOK_RECOVERY_MAX_DELAY_MS,
} from "../../services/webhook-recovery.js";
import { AdminAuthError, requireFreshAdminAuth, type AdminIdentity } from "./admin.auth.js";
import { AdminControlError } from "./admin.controls.js";
import type { AuthRuntime } from "../../auth.js";

const idParam = z.object({ id: AdminResourceIdSchema }).strict();

type Actor = { principalId: string; userId: string; role: "ADMIN_SUPER" };
type Trace = { requestId: string; correlationId: string };

function financeError(error: unknown): never {
  if (error instanceof AdminControlError) throw error;
  if (error instanceof PlatformControlDenied)
    throw new AdminControlError("ADMIN_ACTION_NOT_ALLOWED", 403, error.message);
  if (error instanceof PaymentServiceError || error instanceof RefundServiceError) {
    if (error.code === "PAYPAL_UNAVAILABLE")
      throw new AdminControlError(
        "ADMIN_UNAVAILABLE",
        503,
        "PayPal Sandbox is not configured for administration.",
      );
    if (error.code === "REFUND_POLICY_BLOCKED")
      throw new AdminControlError(
        "ADMIN_ACTION_NOT_ALLOWED",
        409,
        "The existing refund policy blocked this request.",
      );
    throw new AdminControlError(
      "ADMIN_RECONCILE_FAILED",
      503,
      "Provider confirmation is pending. Retry the same request after checking current state.",
    );
  }
  if (isDatabaseError(error)) {
    if (error.code === "NOT_FOUND")
      throw new AdminControlError(
        "ADMIN_TARGET_NOT_FOUND",
        404,
        "The requested record was not found.",
      );
    if (error.code === "CONFLICT")
      throw new AdminControlError(
        "CONFLICT",
        409,
        "The record changed. Reload its current state before trying again.",
      );
    if (error.code === "INVALID_STATE" || error.code === "REFUND_EXCEEDS_REMAINING")
      throw new AdminControlError(
        "INVALID_STATE",
        409,
        "The record is not in a valid state for this action.",
      );
    if (error.code === "INVALID_DOMAIN_INPUT" || error.code === "INVALID_CURRENCY")
      throw new AdminControlError(
        "ADMIN_INVALID_REQUEST",
        400,
        "Check the action details and try again.",
      );
    if (error.code === "OWNERSHIP_REQUIRED")
      throw new AdminControlError("ADMIN_FORBIDDEN", 403, "This action is not permitted.");
  }
  throw error;
}

function paymentContext(database: DatabaseClient, paypal: PayPalClient): PaymentServiceContext {
  return {
    database,
    paypal,
    appUrl: "https://127.0.0.1",
    lookupDemoProduct: async () => null,
  };
}

async function claimAndReuse(options: {
  tx: Prisma.TransactionClient;
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  requestKey: string;
  action: AdminAuditAction;
  targetType: "PAYMENT" | "REFUND" | "WEBHOOK";
  targetId: string;
  reason: string;
  beforeSummaryJson: unknown;
  requestSummaryJson: unknown;
}) {
  const claimed = await new AdminActionRepository(options.db).claimInTransaction(options.tx, {
    actor: options.actor,
    action: options.action,
    targetType: options.targetType,
    targetId: options.targetId,
    reason: options.reason,
    requestId: options.trace.requestId,
    correlationId: options.trace.correlationId,
    beforeSummaryJson: options.beforeSummaryJson,
    requestKey: options.requestKey,
    requestSummaryJson: options.requestSummaryJson,
  });
  if (!claimed.created) {
    if (claimed.status === "FAILED")
      throw new AdminControlError("CONFLICT", 409, "This action key cannot be retried.");
    if (claimed.status === "COMPLETED")
      return { actionId: claimed.actionId, reuse: true as const, resume: false as const };
    return { actionId: claimed.actionId, reuse: false as const, resume: true as const };
  }
  return { actionId: claimed.actionId, reuse: false as const, resume: false as const };
}

async function succeed(options: {
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  actionId: string;
  afterSummaryJson: unknown;
  result?: "SUCCESS" | "PENDING";
}) {
  await new AdminActionRepository(options.db).recordOutcome(options.actionId, {
    actor: options.actor,
    requestId: options.trace.requestId,
    correlationId: options.trace.correlationId,
    result: options.result ?? "SUCCESS",
    afterSummaryJson: options.afterSummaryJson,
  });
}

async function failQuietly(options: {
  db: DatabaseClient;
  actor: Actor;
  trace: Trace;
  actionId: string;
  errorCode: "PROVIDER_UNAVAILABLE" | "PROVIDER_PENDING" | "DOMAIN_REJECTED" | "CONFLICT";
  afterSummaryJson?: unknown;
}) {
  try {
    await new AdminActionRepository(options.db).recordOutcome(options.actionId, {
      actor: options.actor,
      requestId: options.trace.requestId,
      correlationId: options.trace.correlationId,
      result: "FAILURE",
      errorCode: options.errorCode,
      afterSummaryJson: options.afterSummaryJson,
    });
  } catch {
    // Domain work may already have finished; keep the original mapped error.
  }
}

export function registerAdminFinanceRoutes(
  scope: FastifyInstance,
  options: {
    getDatabase: () => DatabaseClient;
    getSecret: () => string;
    getPaypal: () => PayPalClient | null;
    runtime: () => AuthRuntime;
    identity: (request: FastifyRequest) => AdminIdentity;
    sendError: (
      reply: FastifyReply,
      request: FastifyRequest,
      code: string,
      status: number,
      message: string,
    ) => unknown;
    trace: (request: FastifyRequest) => Trace;
  },
) {
  const actorOf = (identity: AdminIdentity): Actor => ({
    principalId: identity.principalId,
    userId: identity.user.id,
    role: identity.role,
  });
  const operations = () =>
    new AdminOperationsRepository(options.getDatabase(), options.getSecret());
  async function mutate(request: FastifyRequest, reply: FastifyReply, run: () => Promise<object>) {
    try {
      return { ...(await run()), ...options.trace(request) };
    } catch (error) {
      if (error instanceof AdminControlError)
        return options.sendError(reply, request, error.code, error.status, error.message);
      try {
        financeError(error);
      } catch (mapped) {
        if (mapped instanceof AdminControlError)
          return options.sendError(reply, request, mapped.code, mapped.status, mapped.message);
        throw mapped;
      }
    }
  }
  async function requireFresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      await requireFreshAdminAuth(options.runtime(), request);
      return true;
    } catch (error) {
      if (error instanceof AdminAuthError) {
        options.sendError(reply, request, error.code, error.status, error.message);
        return false;
      }
      throw error;
    }
  }
  function requirePaypal() {
    const paypal = options.getPaypal();
    if (!paypal)
      throw new AdminControlError(
        "ADMIN_UNAVAILABLE",
        503,
        "PayPal Sandbox is not configured for administration.",
      );
    return paypal;
  }

  scope.post("/orders/:id/reconcile", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseReconcile(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      reconcilePayment({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        paymentId: parsed.id,
        input: parsed.input,
        requireOrder: true,
        operations: operations(),
      }),
    );
  });
  scope.post("/payments/:id/reconcile", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseReconcile(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      reconcilePayment({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        paymentId: parsed.id,
        input: parsed.input,
        requireOrder: false,
        operations: operations(),
      }),
    );
  });
  scope.post("/payments/:id/refund", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseRefund(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    if (!(await requireFresh(request, reply))) return;
    return mutate(request, reply, () =>
      initiateRefund({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        paymentId: parsed.id,
        input: parsed.input,
        operations: operations(),
      }),
    );
  });
  scope.post("/refunds/:id/refresh", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseRefundRefresh(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      refreshRefund({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        refundId: parsed.id,
        input: parsed.input,
        operations: operations(),
      }),
    );
  });
  scope.post("/webhooks/:id/retry", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseWebhookRetry(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      retryWebhook({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        eventId: parsed.id,
        input: parsed.input,
        operations: operations(),
      }),
    );
  });
  scope.post("/webhooks/:id/reconcile", { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = parseWebhookReconcile(request);
    if (!parsed.ok)
      return options.sendError(reply, request, parsed.code, parsed.status, parsed.message);
    return mutate(request, reply, () =>
      reconcileWebhook({
        db: options.getDatabase(),
        secret: options.getSecret(),
        paypal: requirePaypal(),
        actor: actorOf(options.identity(request)),
        trace: options.trace(request),
        eventId: parsed.id,
        input: parsed.input,
        operations: operations(),
      }),
    );
  });
}

function parseReconcile(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminPaymentReconcileMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseRefund(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminPaymentRefundMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  if (input.data.typedConfirmation !== id.data.id)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Type the complete target ID exactly as shown.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseRefundRefresh(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminRefundRefreshMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseWebhookRetry(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminWebhookRetryMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

function parseWebhookReconcile(request: FastifyRequest) {
  const id = idParam.safeParse(request.params);
  const input = AdminWebhookReconcileMutationSchema.safeParse(request.body);
  if (!id.success || !input.success)
    return {
      ok: false as const,
      code: "ADMIN_INVALID_REQUEST",
      status: 400,
      message: "Check the action details and try again.",
    };
  return { ok: true as const, id: id.data.id, input: input.data };
}

async function reconcilePayment(input: {
  db: DatabaseClient;
  secret: string;
  paypal: PayPalClient;
  actor: Actor;
  trace: Trace;
  paymentId: string;
  requireOrder: boolean;
  operations: AdminOperationsRepository;
  input: z.infer<typeof AdminPaymentReconcileMutationSchema>;
}) {
  try {
    const prepared = await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: input.paymentId },
        include: { proposal: { select: { isSample: true } } },
      });
      if (!payment || (input.requireOrder && !payment.paypalOrderId))
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Payment not found.");
      if (payment.isSample || payment.proposal.isSample)
        throw new AdminControlError(
          "INVALID_STATE",
          409,
          "Sample payments cannot be targeted by financial controls.",
        );
      const before = {
        status: payment.status,
        amountMinor: Number(payment.amount),
        currency: "USD" as const,
        isSample: false,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_PAYMENT_RECONCILE_REQUESTED",
        targetType: "PAYMENT",
        targetId: payment.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { status: input.input.expectedStatus, isSample: false },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getPayment(
          payment.id,
        );
        return { reuse: true as const, actionId: claimed.actionId, current };
      }
      if (
        payment.status !== input.input.expectedStatus ||
        payment.updatedAt.toISOString() !== input.input.expectedUpdatedAt
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      return {
        reuse: false as const,
        actionId: claimed.actionId,
        ownerId: payment.userId,
        resume: claimed.resume,
      };
    });
    if (prepared.reuse)
      return {
        data: prepared.current,
        changed: false,
        pending: false,
        actionId: prepared.actionId,
      };
    const result = await reconcilePaypalOrder(
      paymentContext(input.db, input.paypal),
      { id: prepared.ownerId },
      input.paymentId,
    );
    const current = await input.operations.getPayment(input.paymentId);
    await succeed({
      db: input.db,
      actor: input.actor,
      trace: input.trace,
      actionId: prepared.actionId,
      afterSummaryJson: {
        status: result.payment.status,
        amountMinor: result.payment.amount,
        currency: "USD",
        isSample: false,
      },
      result: result.pending ? "PENDING" : "SUCCESS",
    });
    return {
      data: current,
      changed: current?.paymentStatus !== input.input.expectedStatus,
      pending: result.pending,
      actionId: prepared.actionId,
    };
  } catch (error) {
    financeError(error);
  }
}

async function initiateRefund(input: {
  db: DatabaseClient;
  secret: string;
  paypal: PayPalClient;
  actor: Actor;
  trace: Trace;
  paymentId: string;
  operations: AdminOperationsRepository;
  input: z.infer<typeof AdminPaymentRefundMutationSchema>;
}) {
  try {
    const prepared = await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: input.paymentId },
        include: {
          proposal: { select: { isSample: true } },
          refunds: { where: { isSample: false }, select: { amount: true, status: true } },
        },
      });
      if (!payment)
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Payment not found.");
      if (payment.isSample || payment.proposal.isSample)
        throw new AdminControlError(
          "INVALID_STATE",
          409,
          "Sample payments cannot be targeted by financial controls.",
        );
      const refunded = payment.refunds
        .filter((row) => ["REQUESTED", "APPROVED", "SUBMITTED", "COMPLETED"].includes(row.status))
        .reduce((sum, row) => sum + row.amount, 0n);
      const remaining = Number(payment.amount - refunded);
      const expected = input.input.amountMinor === null ? remaining : input.input.amountMinor;
      const before = {
        status: "REQUESTED" as const,
        amountMinor: input.input.reviewedAmountMinor,
        currency: "USD" as const,
        isSample: false,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_REFUND_REQUESTED",
        targetType: "REFUND",
        targetId: payment.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: {
          status: "REQUESTED",
          amountMinor: input.input.reviewedAmountMinor,
          currency: "USD",
        },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getPayment(
          payment.id,
        );
        return { reuse: true as const, actionId: claimed.actionId, current };
      }
      if (expected <= 0 || input.input.reviewedAmountMinor !== expected)
        throw new AdminControlError(
          "ADMIN_INVALID_REQUEST",
          400,
          "Review the remaining refundable amount before continuing.",
        );
      if (
        payment.status !== input.input.expectedStatus ||
        payment.updatedAt.toISOString() !== input.input.expectedUpdatedAt
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      return {
        reuse: false as const,
        actionId: claimed.actionId,
        ownerId: payment.userId,
        amountMinor: input.input.amountMinor,
      };
    });
    if (prepared.reuse)
      return {
        data: prepared.current,
        changed: false,
        pending: false,
        actionId: prepared.actionId,
      };
    try {
      const result = await refundPayment(
        { database: input.db, paypal: input.paypal },
        { id: prepared.ownerId },
        {
          paymentId: input.paymentId,
          amountMinor: prepared.amountMinor,
          reason: input.input.reason,
          requestKey: input.input.requestKey,
          confirmed: true,
        },
      );
      const current = await input.operations.getPayment(input.paymentId);
      await succeed({
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: prepared.actionId,
        afterSummaryJson: {
          status: result.refund.status,
          amountMinor: result.refund.amount,
          currency: "USD",
          isSample: false,
        },
        result: result.pending ? "PENDING" : "SUCCESS",
      });
      return {
        data: current,
        changed: true,
        pending: result.pending,
        actionId: prepared.actionId,
      };
    } catch (error) {
      if (
        error instanceof PlatformControlDenied ||
        (error instanceof RefundServiceError && error.code === "REFUND_POLICY_BLOCKED")
      ) {
        await failQuietly({
          db: input.db,
          actor: input.actor,
          trace: input.trace,
          actionId: prepared.actionId,
          errorCode: "DOMAIN_REJECTED",
        });
      }
      throw error;
    }
  } catch (error) {
    financeError(error);
  }
}

async function refreshRefund(input: {
  db: DatabaseClient;
  secret: string;
  paypal: PayPalClient;
  actor: Actor;
  trace: Trace;
  refundId: string;
  operations: AdminOperationsRepository;
  input: z.infer<typeof AdminRefundRefreshMutationSchema>;
}) {
  try {
    const prepared = await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${input.refundId} FOR UPDATE`;
      const refund = await tx.refund.findUnique({
        where: { id: input.refundId },
        include: { payment: { select: { isSample: true, id: true } } },
      });
      if (!refund) throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Refund not found.");
      if (refund.isSample || refund.payment.isSample)
        throw new AdminControlError(
          "INVALID_STATE",
          409,
          "Sample refunds cannot be targeted by financial controls.",
        );
      const before = {
        status: refund.status,
        amountMinor: Number(refund.amount),
        currency: "USD" as const,
        isSample: false,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_REFUND_REFRESH_REQUESTED",
        targetType: "REFUND",
        targetId: refund.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { status: input.input.expectedStatus, isSample: false },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getRefund(refund.id);
        return { reuse: true as const, actionId: claimed.actionId, current };
      }
      if (
        refund.status !== input.input.expectedStatus ||
        refund.updatedAt.toISOString() !== input.input.expectedUpdatedAt
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      return {
        reuse: false as const,
        actionId: claimed.actionId,
        ownerId: refund.userId,
        paymentId: refund.payment.id,
      };
    });
    if (prepared.reuse)
      return {
        data: prepared.current,
        changed: false,
        pending: false,
        actionId: prepared.actionId,
      };
    const result = await reconcileRefundStatus(
      { database: input.db, paypal: input.paypal },
      { id: prepared.ownerId },
      prepared.paymentId,
    );
    const current = await input.operations.getRefund(input.refundId);
    await succeed({
      db: input.db,
      actor: input.actor,
      trace: input.trace,
      actionId: prepared.actionId,
      afterSummaryJson: {
        status: current?.status ?? input.input.expectedStatus,
        amountMinor: current?.amountMinor ?? 0,
        currency: "USD",
        isSample: false,
      },
      result: result.pending ? "PENDING" : "SUCCESS",
    });
    return {
      data: current,
      changed: current?.status !== input.input.expectedStatus,
      pending: result.pending,
      actionId: prepared.actionId,
    };
  } catch (error) {
    financeError(error);
  }
}

async function retryWebhook(input: {
  db: DatabaseClient;
  secret: string;
  paypal: PayPalClient;
  actor: Actor;
  trace: Trace;
  eventId: string;
  operations: AdminOperationsRepository;
  input: z.infer<typeof AdminWebhookRetryMutationSchema>;
}) {
  try {
    const now = new Date();
    const prepared = await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookInbox" WHERE id = ${input.eventId} FOR UPDATE`;
      const row = await tx.webhookInbox.findUnique({ where: { id: input.eventId } });
      if (!row)
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Webhook event not found.");
      const leaseCutoff = new Date(now.getTime() - WEBHOOK_RECOVERY_LEASE_MS);
      const due =
        row.signatureVerified &&
        row.attempts < WEBHOOK_RECOVERY_MAX_ATTEMPTS &&
        ((row.status === "FAILED" && (row.nextAttemptAt === null || row.nextAttemptAt <= now)) ||
          (row.status === "PROCESSING" && row.updatedAt <= leaseCutoff));
      const before = {
        status: row.status,
        signatureVerified: row.signatureVerified,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_WEBHOOK_RETRY_REQUESTED",
        targetType: "WEBHOOK",
        targetId: row.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: {
          status: input.input.expectedStatus,
          attempts: input.input.expectedAttempts,
          signatureVerified: true,
        },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getWebhook(row.id);
        return { reuse: true as const, actionId: claimed.actionId, current };
      }
      if (
        row.status !== input.input.expectedStatus ||
        row.updatedAt.toISOString() !== input.input.expectedUpdatedAt ||
        row.attempts !== input.input.expectedAttempts
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      if (!claimed.resume && !due)
        throw new AdminControlError(
          "ADMIN_RETRY_NOT_ALLOWED",
          409,
          "Retry is limited to verified due failures or stale processing leases under the five-attempt cap.",
        );
      return { reuse: false as const, actionId: claimed.actionId, resume: claimed.resume };
    });
    if (prepared.reuse)
      return {
        data: prepared.current,
        changed: false,
        pending: false,
        actionId: prepared.actionId,
      };
    const store = new PrismaWebhookInboxStore(input.db);
    const current = await input.db.webhookInbox.findUnique({ where: { id: input.eventId } });
    if (prepared.resume && current && ["PROCESSED", "IGNORED"].includes(current.status)) {
      const snapshot = await input.operations.getWebhook(input.eventId);
      await succeed({
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: prepared.actionId,
        afterSummaryJson: {
          status: current.status,
          signatureVerified: current.signatureVerified,
          attempts: current.attempts,
          nextAttemptAt: current.nextAttemptAt?.toISOString() ?? null,
        },
      });
      return { data: snapshot, changed: false, pending: false, actionId: prepared.actionId };
    }
    const claimedInbox = await store.claimVerifiedForReplay(
      input.eventId,
      now,
      WEBHOOK_RECOVERY_MAX_ATTEMPTS,
      WEBHOOK_RECOVERY_LEASE_MS,
    );
    if (!claimedInbox) {
      await failQuietly({
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: prepared.actionId,
        errorCode: "CONFLICT",
      });
      throw new AdminControlError(
        "ADMIN_RETRY_NOT_ALLOWED",
        409,
        "Retry is limited to verified due failures or stale processing leases under the five-attempt cap.",
      );
    }
    const service = createPayPalWebhookService(input.db, input.paypal);
    try {
      const outcome = await service.replayVerified({
        inboxId: claimedInbox.id,
        event: claimedInbox.payload,
      });
      if (outcome === "processed") await store.markProcessed(claimedInbox.id);
      else if (outcome === "ignored")
        await store.markIgnored(claimedInbox.id, "Verified webhook replay was ignored.");
      else {
        const delay = Math.min(
          WEBHOOK_RECOVERY_MAX_DELAY_MS,
          WEBHOOK_RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, claimedInbox.attempts - 1),
        );
        await store.scheduleRetry(
          claimedInbox.id,
          claimedInbox.attempts >= WEBHOOK_RECOVERY_MAX_ATTEMPTS
            ? null
            : new Date(now.getTime() + delay),
          claimedInbox.attempts >= WEBHOOK_RECOVERY_MAX_ATTEMPTS
            ? "Verified webhook reconciliation is pending. Retry limit reached."
            : "Verified webhook reconciliation is pending.",
        );
      }
      const snapshot = await input.operations.getWebhook(input.eventId);
      await succeed({
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        actionId: prepared.actionId,
        afterSummaryJson: {
          status: snapshot?.status ?? "PROCESSING",
          signatureVerified: snapshot?.signatureVerified ?? true,
          attempts: snapshot?.attempts ?? claimedInbox.attempts,
          nextAttemptAt: snapshot?.nextAttemptAt ?? null,
        },
        result: outcome === "pending" ? "PENDING" : "SUCCESS",
      });
      return {
        data: snapshot,
        changed: true,
        pending: outcome === "pending",
        actionId: prepared.actionId,
      };
    } catch (error) {
      const delay = Math.min(
        WEBHOOK_RECOVERY_MAX_DELAY_MS,
        WEBHOOK_RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, claimedInbox.attempts - 1),
      );
      await store.scheduleRetry(
        claimedInbox.id,
        claimedInbox.attempts >= WEBHOOK_RECOVERY_MAX_ATTEMPTS
          ? null
          : new Date(now.getTime() + delay),
        "Verified webhook recovery failed.",
      );
      throw error;
    }
  } catch (error) {
    financeError(error);
  }
}

async function reconcileWebhook(input: {
  db: DatabaseClient;
  secret: string;
  paypal: PayPalClient;
  actor: Actor;
  trace: Trace;
  eventId: string;
  operations: AdminOperationsRepository;
  input: z.infer<typeof AdminWebhookReconcileMutationSchema>;
}) {
  try {
    const prepared = await input.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookInbox" WHERE id = ${input.eventId} FOR UPDATE`;
      const row = await tx.webhookInbox.findUnique({ where: { id: input.eventId } });
      if (!row)
        throw new AdminControlError("ADMIN_TARGET_NOT_FOUND", 404, "Webhook event not found.");
      const links = await new AdminOperationsRepository(tx, input.secret).webhookFinancialLinks(
        row.id,
      );
      if (!links || links.paymentIds.length !== 1)
        throw new AdminControlError(
          "ADMIN_RETRY_NOT_ALLOWED",
          409,
          "Linked reconciliation requires exactly one matching order or payment.",
        );
      const before = {
        status: row.status,
        signatureVerified: row.signatureVerified,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      };
      const claimed = await claimAndReuse({
        tx,
        db: input.db,
        actor: input.actor,
        trace: input.trace,
        requestKey: input.input.requestKey,
        action: "ADMIN_WEBHOOK_RECONCILE_REQUESTED",
        targetType: "WEBHOOK",
        targetId: row.id,
        reason: input.input.reason,
        beforeSummaryJson: before,
        requestSummaryJson: { status: input.input.expectedStatus, signatureVerified: true },
      });
      if (claimed.reuse) {
        const current = await new AdminOperationsRepository(tx, input.secret).getWebhook(row.id);
        return { reuse: true as const, actionId: claimed.actionId, current };
      }
      if (
        row.status !== input.input.expectedStatus ||
        row.updatedAt.toISOString() !== input.input.expectedUpdatedAt
      )
        throw new AdminControlError(
          "CONFLICT",
          409,
          "The record changed. Reload its current state before trying again.",
        );
      return {
        reuse: false as const,
        actionId: claimed.actionId,
        paymentId: links.paymentIds[0]!,
      };
    });
    if (prepared.reuse)
      return {
        data: prepared.current,
        changed: false,
        pending: false,
        actionId: prepared.actionId,
      };
    const payment = await input.db.payment.findUnique({
      where: { id: prepared.paymentId },
      select: { userId: true, id: true },
    });
    if (!payment)
      throw new AdminControlError(
        "ADMIN_RETRY_NOT_ALLOWED",
        409,
        "Linked reconciliation requires exactly one matching order or payment.",
      );
    const order = await reconcilePaypalOrder(
      paymentContext(input.db, input.paypal),
      { id: payment.userId },
      payment.id,
    );
    const refunds = await reconcileRefundStatus(
      { database: input.db, paypal: input.paypal },
      { id: payment.userId },
      payment.id,
    );
    const snapshot = await input.operations.getWebhook(input.eventId);
    await succeed({
      db: input.db,
      actor: input.actor,
      trace: input.trace,
      actionId: prepared.actionId,
      afterSummaryJson: {
        status: snapshot?.status ?? input.input.expectedStatus,
        signatureVerified: snapshot?.signatureVerified ?? true,
        attempts: snapshot?.attempts ?? 0,
        nextAttemptAt: snapshot?.nextAttemptAt ?? null,
      },
      result: order.pending || refunds.pending ? "PENDING" : "SUCCESS",
    });
    return {
      data: snapshot,
      changed: false,
      pending: order.pending || refunds.pending,
      actionId: prepared.actionId,
    };
  } catch (error) {
    financeError(error);
  }
}
