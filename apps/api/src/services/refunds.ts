import { createHash, randomUUID } from "node:crypto";
import {
  AuditEntityType,
  AuditEventType,
  DatabaseError,
  PaymentStatus,
  RefundStatus,
  assertCurrency,
  assertMinorUnits,
  type DatabaseClient,
  type Prisma,
} from "@mandatepay/database";
import { evaluateRefundPolicy, type RefundReasonCode } from "@mandatepay/agentguard";
import {
  PayPalError,
  parseProviderMoney,
  type PayPalCapture,
  type PayPalRefund,
} from "@mandatepay/paypal";
import { toMinorUnits } from "@mandatepay/shared";
import { paymentReceiptInclude, serializePayment, type PaymentReceipt } from "./payments.js";

type Owner = { id: string };
type TransactionClient = Prisma.TransactionClient;

const activeRefundStatuses: RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.APPROVED,
  RefundStatus.SUBMITTED,
  RefundStatus.COMPLETED,
];

const refundInclude = {
  payment: { include: paymentReceiptInclude },
} as const;

type RefundRecord = Prisma.RefundGetPayload<{ include: typeof refundInclude }>;

export interface RefundGateway {
  getCapture(captureId: string): Promise<PayPalCapture>;
  refundCapture(input: unknown): Promise<PayPalRefund>;
  getRefund(refundId: string): Promise<PayPalRefund>;
}

export interface RefundServiceContext {
  readonly database: DatabaseClient;
  readonly paypal: RefundGateway | null;
}

export class RefundServiceError extends Error {
  constructor(
    readonly code:
      | "PAYPAL_UNAVAILABLE"
      | "PAYPAL_RESPONSE_INVALID"
      | "PAYPAL_OUTCOME_UNKNOWN"
      | "REFUND_POLICY_BLOCKED",
    readonly httpStatus = 503,
    readonly reasonCodes: readonly RefundReasonCode[] = [],
  ) {
    super("The refund service could not complete this request.");
    this.name = "RefundServiceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RefundDTO {
  readonly id: string;
  readonly status: RefundStatus;
  readonly amount: number;
  readonly currency: "USD";
  readonly paypalRefundId: string | null;
}

export interface RefundResult {
  readonly refund: RefundDTO;
  readonly payment: ReturnType<typeof serializePayment>;
  readonly pending: boolean;
}

function safeAmount(value: bigint, field: string): number {
  assertMinorUnits(value, field);
  return Number(value);
}

function serializeRefund(refund: {
  id: string;
  status: RefundStatus;
  amount: bigint;
  currency: string;
  paypalRefundId: string | null;
}): RefundDTO {
  assertCurrency(refund.currency);
  if (refund.currency !== "USD") {
    throw new DatabaseError("INVALID_CURRENCY", "Only USD refunds are supported.");
  }
  return {
    id: refund.id,
    status: refund.status,
    amount: safeAmount(refund.amount, "refund amount"),
    currency: "USD",
    paypalRefundId: refund.paypalRefundId,
  };
}

function requestFingerprint(input: {
  paymentId: string;
  amountMinor: number | null;
  reason: string;
  confirmed: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amountMinor: input.amountMinor,
        confirmed: input.confirmed,
        paymentId: input.paymentId,
        reason: input.reason,
      }),
    )
    .digest("hex");
}

function providerTimestamp(refund: PayPalRefund): Date {
  if (!refund.create_time || !/Z$/u.test(refund.create_time)) {
    throw new RefundServiceError("PAYPAL_RESPONSE_INVALID");
  }
  const parsed = new Date(refund.create_time);
  if (Number.isNaN(parsed.getTime())) throw new RefundServiceError("PAYPAL_RESPONSE_INVALID");
  return parsed;
}

function validateCapture(capture: PayPalCapture, payment: PaymentReceipt): void {
  if (
    capture.id !== payment.paypalCaptureId ||
    !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(capture.status) ||
    capture.amount.currency_code !== "USD" ||
    parseProviderMoney(capture.amount) !== Number(payment.amount) ||
    (capture.custom_id !== undefined && capture.custom_id !== payment.proposalId)
  ) {
    throw new RefundServiceError("PAYPAL_RESPONSE_INVALID", 409);
  }
}

function validateProviderRefund(
  refund: PayPalRefund,
  local: RefundRecord,
  payment: PaymentReceipt,
): void {
  if (
    !refund.id ||
    refund.amount.currency_code !== "USD" ||
    parseProviderMoney(refund.amount) !== Number(local.amount) ||
    (refund.invoice_id !== undefined && refund.invoice_id !== local.id) ||
    (refund.capture_id !== undefined && refund.capture_id !== payment.paypalCaptureId)
  ) {
    throw new RefundServiceError("PAYPAL_RESPONSE_INVALID");
  }
}

function isPendingProviderError(error: unknown): boolean {
  return error instanceof PayPalError || error instanceof RefundServiceError;
}

async function lockPaymentInOrder(
  tx: TransactionClient,
  userId: string,
  paymentId: string,
): Promise<PaymentReceipt> {
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
  const unlocked = await tx.payment.findFirst({
    where: { id: paymentId, userId },
    select: { id: true, mandateId: true, proposalId: true },
  });
  if (!unlocked) throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
  await tx.$queryRawUnsafe('SELECT id FROM "Mandate" WHERE id = $1 FOR UPDATE', unlocked.mandateId);
  await tx.$queryRawUnsafe(
    'SELECT id FROM "PurchaseProposal" WHERE id = $1 FOR UPDATE',
    unlocked.proposalId,
  );
  await tx.$queryRawUnsafe('SELECT id FROM "Payment" WHERE id = $1 FOR UPDATE', unlocked.id);
  const payment = await tx.payment.findFirst({
    where: { id: unlocked.id, userId },
    include: paymentReceiptInclude,
  });
  if (!payment) throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
  return payment;
}

async function refundResult(
  context: RefundServiceContext,
  userId: string,
  refundId: string,
  pending: boolean,
): Promise<RefundResult> {
  const refund = await context.database.refund.findFirst({
    where: { id: refundId, userId },
    include: refundInclude,
  });
  if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
  return {
    refund: serializeRefund(refund),
    payment: serializePayment(refund.payment),
    pending,
  };
}

async function claimRefund(
  context: RefundServiceContext,
  user: Owner,
  input: {
    paymentId: string;
    amountMinor: number | null;
    reason: string;
    requestKey: string;
    confirmed: true;
  },
) {
  const fingerprint = requestFingerprint(input);
  return context.database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const existing = await tx.refund.findFirst({
      where: { userId: user.id, idempotencyKey: input.requestKey },
      include: refundInclude,
    });
    if (existing) {
      if (existing.paymentId !== input.paymentId) {
        throw new DatabaseError("CONFLICT", "Refund request key belongs to another payment.");
      }
      if (existing.requestFingerprint !== fingerprint) {
        throw new DatabaseError("CONFLICT", "Refund request key was reused with different data.");
      }
      return { refund: existing, created: false } as const;
    }

    const payment = await lockPaymentInOrder(tx, user.id, input.paymentId);
    if (
      payment.status !== PaymentStatus.COMPLETED &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new DatabaseError("INVALID_STATE", "Only a completed payment can be refunded.");
    }
    if (!payment.paypalCaptureId || payment.currency !== "USD") {
      throw new DatabaseError("INVALID_STATE", "The captured payment is not refundable.");
    }
    const aggregate = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: { in: activeRefundStatuses } },
      _sum: { amount: true },
    });
    const alreadyRefunded = aggregate._sum.amount ?? 0n;
    const requestedAmount =
      input.amountMinor === null ? payment.amount - alreadyRefunded : BigInt(input.amountMinor);
    assertMinorUnits(requestedAmount, "refund amount");
    const decision = evaluateRefundPolicy({
      ownsPayment: payment.userId === user.id,
      paymentStatus: payment.status,
      paymentCurrency: payment.currency as "USD",
      requestedCurrency: "USD",
      capturedAmount: toMinorUnits(safeAmount(payment.amount, "captured amount")),
      alreadyRefundedAmount: toMinorUnits(safeAmount(alreadyRefunded, "refunded amount")),
      requestedAmount: toMinorUnits(safeAmount(requestedAmount, "requested refund amount")),
      explicitConfirmation: input.confirmed,
    });
    if (decision.decision !== "ALLOW") {
      throw new RefundServiceError("REFUND_POLICY_BLOCKED", 409, decision.reasonCodes);
    }

    const refund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        userId: user.id,
        amount: requestedAmount,
        currency: "USD",
        status: RefundStatus.REQUESTED,
        reason: input.reason,
        idempotencyKey: input.requestKey,
        requestFingerprint: fingerprint,
        paypalRequestId: randomUUID(),
      },
      include: refundInclude,
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.REFUND_REQUESTED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        dedupeKey: `paypal-refund-requested:${refund.id}`,
        payload: {
          refundId: refund.id,
          paymentId: payment.id,
          amount: Number(requestedAmount),
          currency: "USD",
          requestFingerprint: fingerprint,
        },
      },
    });
    return { refund, created: true } as const;
  });
}

async function markSubmitted(
  context: RefundServiceContext,
  user: Owner,
  refundId: string,
): Promise<RefundRecord> {
  return context.database.$transaction(async (tx) => {
    const refund = await tx.refund.findFirst({
      where: { id: refundId, userId: user.id },
      select: { id: true, paymentId: true, status: true },
    });
    if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    const payment = await lockPaymentInOrder(tx, user.id, refund.paymentId);
    const locked = await tx.refund.findFirst({
      where: { id: refund.id, userId: user.id },
      include: refundInclude,
    });
    if (!locked) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    if (
      locked.status === RefundStatus.COMPLETED ||
      locked.status === RefundStatus.FAILED ||
      locked.status === RefundStatus.CANCELLED
    ) {
      return locked;
    }
    if (locked.status === RefundStatus.SUBMITTED) return locked;
    if (locked.status !== RefundStatus.REQUESTED && locked.status !== RefundStatus.APPROVED) {
      throw new DatabaseError("INVALID_STATE", "Refund is not ready for provider submission.");
    }
    await tx.refund.update({
      where: { id: locked.id },
      data: { status: RefundStatus.SUBMITTED },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.REFUND_APPROVED,
        entityType: AuditEntityType.REFUND,
        entityId: locked.id,
        dedupeKey: `paypal-refund-submitted:${locked.id}`,
        payload: { refundId: locked.id, paymentId: payment.id },
      },
    });
    const submitted = await tx.refund.findUnique({
      where: { id: locked.id },
      include: refundInclude,
    });
    if (!submitted) throw new DatabaseError("NOT_FOUND", "Refund was not found after submission.");
    return submitted;
  });
}

async function persistProviderRefund(
  context: RefundServiceContext,
  user: Owner,
  refundId: string,
  providerRefund: PayPalRefund,
): Promise<RefundRecord> {
  return context.database.$transaction(async (tx) => {
    const initial = await tx.refund.findFirst({ where: { id: refundId, userId: user.id } });
    if (!initial) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    const payment = await lockPaymentInOrder(tx, user.id, initial.paymentId);
    const refund = await tx.refund.findFirst({
      where: { id: refundId, userId: user.id },
      include: refundInclude,
    });
    if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    if (refund.paypalRefundId && refund.paypalRefundId !== providerRefund.id) {
      throw new DatabaseError("CONFLICT", "Refund is already bound to another provider refund.");
    }
    if (refund.status === RefundStatus.COMPLETED) return refund;
    if (refund.status !== RefundStatus.SUBMITTED) {
      throw new DatabaseError("INVALID_STATE", "Refund is not awaiting provider confirmation.");
    }
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: { paypalRefundId: providerRefund.id },
      include: refundInclude,
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYPAL_REFUND_CREATED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        dedupeKey: `paypal-refund-provider:${refund.id}:${providerRefund.id}`,
        payload: {
          refundId: refund.id,
          paymentId: payment.id,
          paypalRefundId: providerRefund.id,
        },
      },
    });
    return updated;
  });
}

async function completeRefund(
  context: RefundServiceContext,
  user: Owner,
  refundId: string,
  providerRefund: PayPalRefund,
  settledAt: Date,
): Promise<RefundRecord> {
  return context.database.$transaction(async (tx) => {
    const initial = await tx.refund.findFirst({ where: { id: refundId, userId: user.id } });
    if (!initial) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    const payment = await lockPaymentInOrder(tx, user.id, initial.paymentId);
    const refund = await tx.refund.findFirst({
      where: { id: refundId, userId: user.id },
      include: refundInclude,
    });
    if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    if (refund.status === RefundStatus.COMPLETED) {
      if (refund.paypalRefundId === providerRefund.id) return refund;
      throw new DatabaseError("CONFLICT", "Refund is already completed with another provider ID.");
    }
    if (
      refund.status !== RefundStatus.SUBMITTED &&
      refund.status !== RefundStatus.REQUESTED &&
      refund.status !== RefundStatus.APPROVED
    ) {
      throw new DatabaseError("INVALID_STATE", "Refund is not ready to complete.");
    }
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: { paypalRefundId: providerRefund.id, status: RefundStatus.COMPLETED, settledAt },
      include: refundInclude,
    });
    const aggregate = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status:
          (aggregate._sum.amount ?? 0n) >= payment.amount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.REFUND_COMPLETED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        dedupeKey: `paypal-refund-completed:${refund.id}:${providerRefund.id}`,
        payload: {
          refundId: refund.id,
          paymentId: payment.id,
          paypalRefundId: providerRefund.id,
          settledAt: settledAt.toISOString(),
        },
      },
    });
    return updated;
  });
}

async function markRefundFailed(
  context: RefundServiceContext,
  user: Owner,
  refundId: string,
  providerRefund: PayPalRefund,
) {
  return context.database.$transaction(async (tx) => {
    const initial = await tx.refund.findFirst({ where: { id: refundId, userId: user.id } });
    if (!initial) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    const payment = await lockPaymentInOrder(tx, user.id, initial.paymentId);
    const refund = await tx.refund.findFirst({
      where: { id: refundId, userId: user.id },
      include: refundInclude,
    });
    if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
    if (refund.status === RefundStatus.COMPLETED) return refund;
    const status =
      providerRefund.status === "CANCELLED" ? RefundStatus.CANCELLED : RefundStatus.FAILED;
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: {
        paypalRefundId: providerRefund.id,
        status,
        failureCode:
          providerRefund.status === "CANCELLED"
            ? "PAYPAL_REFUND_CANCELLED"
            : "PAYPAL_REFUND_FAILED",
      },
      include: refundInclude,
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.REFUND_FAILED,
        entityType: AuditEntityType.REFUND,
        entityId: refund.id,
        dedupeKey: `paypal-refund-failed:${refund.id}:${providerRefund.id}`,
        payload: {
          refundId: refund.id,
          paymentId: payment.id,
          paypalRefundId: providerRefund.id,
          failureCode: updated.failureCode ?? "PAYPAL_REFUND_FAILED",
        },
      },
    });
    return updated;
  });
}

async function providerCapture(
  context: RefundServiceContext,
  payment: PaymentReceipt,
): Promise<PayPalCapture> {
  if (!context.paypal || !payment.paypalCaptureId) {
    throw new RefundServiceError("PAYPAL_UNAVAILABLE");
  }
  try {
    const capture = await context.paypal.getCapture(payment.paypalCaptureId);
    validateCapture(capture, payment);
    return capture;
  } catch (error) {
    if (error instanceof RefundServiceError && error.code === "PAYPAL_RESPONSE_INVALID")
      throw error;
    throw new RefundServiceError("PAYPAL_OUTCOME_UNKNOWN");
  }
}

async function currentPaymentForRefund(
  context: RefundServiceContext,
  userId: string,
  refundId: string,
): Promise<{ refund: RefundRecord; payment: PaymentReceipt }> {
  const refund = await context.database.refund.findFirst({
    where: { id: refundId, userId },
    include: refundInclude,
  });
  if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
  return { refund, payment: refund.payment };
}

async function applyProviderRefund(
  context: RefundServiceContext,
  user: Owner,
  refund: RefundRecord,
  payment: PaymentReceipt,
): Promise<RefundResult> {
  if (!context.paypal || !refund.paypalRequestId || !payment.paypalCaptureId) {
    throw new RefundServiceError("PAYPAL_UNAVAILABLE");
  }
  const reconcile = async (providerRefund: PayPalRefund): Promise<RefundResult> => {
    validateProviderRefund(providerRefund, refund, payment);
    if (providerRefund.status === "PENDING") {
      await persistProviderRefund(context, user, refund.id, providerRefund);
      return refundResult(context, user.id, refund.id, true);
    }
    if (providerRefund.status === "COMPLETED") {
      await completeRefund(
        context,
        user,
        refund.id,
        providerRefund,
        providerTimestamp(providerRefund),
      );
      return refundResult(context, user.id, refund.id, false);
    }
    await markRefundFailed(context, user, refund.id, providerRefund);
    return refundResult(context, user.id, refund.id, false);
  };

  if (refund.status === RefundStatus.SUBMITTED && refund.paypalRefundId) {
    try {
      const existing = await context.paypal.getRefund(refund.paypalRefundId);
      return reconcile(existing);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
    }
  }

  try {
    const providerRefund = await context.paypal.refundCapture({
      captureId: payment.paypalCaptureId,
      requestId: refund.paypalRequestId,
      amountMinor: toMinorUnits(safeAmount(refund.amount, "refund amount")),
      invoiceId: refund.id,
      reason: refund.reason,
    });
    return reconcile(providerRefund);
  } catch (error) {
    if (!isPendingProviderError(error)) throw error;
    const current = await currentPaymentForRefund(context, user.id, refund.id);
    return {
      refund: serializeRefund(current.refund),
      payment: serializePayment(current.payment),
      pending: true,
    };
  }
}

export async function refundPayment(
  context: RefundServiceContext,
  user: Owner,
  input: {
    paymentId: string;
    amountMinor: number | null;
    reason: string;
    requestKey: string;
    confirmed: true;
  },
): Promise<RefundResult> {
  if (!context.paypal) throw new RefundServiceError("PAYPAL_UNAVAILABLE");
  const claimed = await claimRefund(context, user, input);
  if (!claimed.created) {
    if (
      claimed.refund.status === RefundStatus.COMPLETED ||
      claimed.refund.status === RefundStatus.FAILED ||
      claimed.refund.status === RefundStatus.CANCELLED
    ) {
      return refundResult(context, user.id, claimed.refund.id, false);
    }
  }
  const payment = (await currentPaymentForRefund(context, user.id, claimed.refund.id)).payment;
  await providerCapture(context, payment);
  const submitted = await markSubmitted(context, user, claimed.refund.id);
  return applyProviderRefund(context, user, submitted, submitted.payment);
}
