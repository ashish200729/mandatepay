import type { PrismaClient } from "../generated/prisma/client.js";
import { PaymentStatus, ProposalStatus, RefundStatus } from "../generated/prisma/enums.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import { assertCurrency, assertMinorUnits, SUPPORTED_CURRENCY } from "../money.js";

export interface CreatePaymentInput {
  userId: string;
  proposalId: string;
  idempotencyKey: string;
}

export interface CreateRefundInput {
  userId: string;
  paymentId: string;
  amount: bigint;
  currency?: string;
  reason?: string;
  idempotencyKey: string;
}

const paymentInclude = {
  proposal: { include: { productSnapshot: true, mandateVersion: true } },
  refunds: { orderBy: { createdAt: "asc" as const } },
} as const;

const activeRefundStatuses: RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.APPROVED,
  RefundStatus.SUBMITTED,
  RefundStatus.COMPLETED,
];

export class PaymentRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  async create(input: CreatePaymentInput) {
    if (!input.idempotencyKey.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Payment idempotencyKey is required.");
    }

    return this.db.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: paymentInclude,
      });
      if (existing) {
        if (existing.userId !== input.userId || existing.proposalId !== input.proposalId) {
          throw new DatabaseError(
            "OWNERSHIP_REQUIRED",
            "Payment idempotency key belongs to another payment.",
          );
        }
        return existing;
      }

      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${input.proposalId} FOR UPDATE`;
      const proposal = await tx.purchaseProposal.findFirst({
        where: { id: input.proposalId, userId: input.userId },
      });
      if (!proposal) {
        throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found for this user.");
      }
      if (proposal.status !== ProposalStatus.AUTHORIZED) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Only an authorized proposal can create a payment.",
        );
      }
      assertCurrency(proposal.currency);
      assertMinorUnits(proposal.total, "payment amount");

      return tx.payment.create({
        data: {
          userId: input.userId,
          mandateId: proposal.mandateId,
          proposalId: proposal.id,
          amount: proposal.total,
          currency: proposal.currency,
          status: PaymentStatus.CREATED,
          idempotencyKey: input.idempotencyKey,
        },
        include: paymentInclude,
      });
    });
  }

  async getByIdForUser(paymentId: string, userId: string) {
    const payment = await this.db.payment.findFirst({
      where: { id: paymentId, userId },
      include: paymentInclude,
    });
    if (!payment) {
      throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
    }
    return payment;
  }

  listForUser(userId: string, take = 50) {
    return this.db.payment.findMany({
      where: { userId },
      include: paymentInclude,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 100),
    });
  }

  async setPaypalOrder(paymentId: string, userId: string, paypalOrderId: string) {
    if (!paypalOrderId.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "PayPal order ID is required.");
    }

    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, userId } });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (payment.paypalOrderId) {
        if (payment.paypalOrderId === paypalOrderId) return payment;
        throw new DatabaseError("CONFLICT", "Payment already has a different PayPal order ID.");
      }
      if (payment.status !== PaymentStatus.CREATED) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Only a newly created payment can receive a PayPal order.",
        );
      }

      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { paypalOrderId },
        include: paymentInclude,
      });
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.PAYPAL_ORDER_CREATED },
      });
      return updated;
    });
  }

  async markOrderApproved(paymentId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, userId } });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (payment.status === PaymentStatus.APPROVED) return payment;
      if (payment.status !== PaymentStatus.CREATED || !payment.paypalOrderId) {
        throw new DatabaseError("INVALID_STATE", "Only a created PayPal order can be approved.");
      }
      return tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.APPROVED },
        include: paymentInclude,
      });
    });
  }

  async markCapturePending(paymentId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, userId } });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (payment.status === PaymentStatus.CAPTURE_PENDING) return payment;
      if (payment.status !== PaymentStatus.APPROVED) {
        throw new DatabaseError("INVALID_STATE", "Only an approved payment can be captured.");
      }
      return tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.CAPTURE_PENDING },
        include: paymentInclude,
      });
    });
  }

  async recordCapture(paymentId: string, userId: string, paypalCaptureId: string) {
    if (!paypalCaptureId.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "PayPal capture ID is required.");
    }

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;
      const payment = await tx.payment.findFirst({ where: { id: paymentId, userId } });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (payment.status === PaymentStatus.COMPLETED) {
        if (payment.paypalCaptureId === paypalCaptureId) return payment;
        throw new DatabaseError(
          "CONFLICT",
          "Payment is already completed with a different capture ID.",
        );
      }
      if (
        payment.status !== PaymentStatus.APPROVED &&
        payment.status !== PaymentStatus.CAPTURE_PENDING
      ) {
        throw new DatabaseError("INVALID_STATE", "Payment is not ready to be captured.");
      }

      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { paypalCaptureId, status: PaymentStatus.COMPLETED, capturedAt: new Date() },
        include: paymentInclude,
      });
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.COMPLETED },
      });
      return updated;
    });
  }

  async markFailed(paymentId: string, userId: string, failureCode: string) {
    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, userId } });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (payment.status === PaymentStatus.COMPLETED) {
        throw new DatabaseError("INVALID_STATE", "A completed payment cannot be marked failed.");
      }
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, failureCode: failureCode.trim() || "UNKNOWN" },
        include: paymentInclude,
      });
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.FAILED },
      });
      return updated;
    });
  }

  async requestRefund(input: CreateRefundInput) {
    assertMinorUnits(input.amount, "refund amount");
    assertCurrency(input.currency ?? SUPPORTED_CURRENCY);
    if (!input.idempotencyKey.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "Refund idempotencyKey is required.");
    }

    return this.db.$transaction(async (tx) => {
      const existing = await tx.refund.findFirst({
        where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        if (existing.userId !== input.userId || existing.paymentId !== input.paymentId) {
          throw new DatabaseError(
            "OWNERSHIP_REQUIRED",
            "Refund idempotency key belongs to another refund.",
          );
        }
        return existing;
      }

      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, userId: input.userId },
      });
      if (!payment) {
        throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
      }
      if (
        payment.status !== PaymentStatus.COMPLETED &&
        payment.status !== PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new DatabaseError("INVALID_STATE", "Only a completed payment can be refunded.");
      }
      const currency = input.currency ?? payment.currency;
      assertCurrency(payment.currency);
      if (currency !== payment.currency) {
        throw new DatabaseError(
          "INVALID_CURRENCY",
          "Refund currency must match the payment currency.",
        );
      }

      const reserved = await tx.refund.aggregate({
        where: { paymentId: payment.id, status: { in: activeRefundStatuses } },
        _sum: { amount: true },
      });
      const alreadyReserved = reserved._sum?.amount ?? 0n;
      const remaining = payment.amount - alreadyReserved;
      if (input.amount > remaining) {
        throw new DatabaseError(
          "REFUND_EXCEEDS_REMAINING",
          "Refund exceeds the remaining refundable amount.",
          {
            remaining: remaining.toString(),
          },
        );
      }

      return tx.refund.create({
        data: {
          paymentId: payment.id,
          userId: input.userId,
          amount: input.amount,
          currency,
          status: RefundStatus.REQUESTED,
          reason: input.reason?.trim() || null,
          idempotencyKey: input.idempotencyKey,
        },
      });
    });
  }

  async markRefundSubmitted(refundId: string, userId: string, paypalRefundId: string) {
    if (!paypalRefundId.trim()) {
      throw new DatabaseError("INVALID_DOMAIN_INPUT", "PayPal refund ID is required.");
    }
    return this.db.$transaction(async (tx) => {
      const refund = await tx.refund.findFirst({ where: { id: refundId, userId } });
      if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
      if (refund.status === RefundStatus.SUBMITTED || refund.status === RefundStatus.COMPLETED) {
        if (refund.paypalRefundId === paypalRefundId) return refund;
        throw new DatabaseError("CONFLICT", "Refund already has a different PayPal refund ID.");
      }
      if (refund.status !== RefundStatus.REQUESTED && refund.status !== RefundStatus.APPROVED) {
        throw new DatabaseError("INVALID_STATE", "Refund is not ready for PayPal submission.");
      }
      return tx.refund.update({
        where: { id: refund.id },
        data: { paypalRefundId, status: RefundStatus.SUBMITTED },
      });
    });
  }

  async markRefundCompleted(refundId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${refundId} FOR UPDATE`;
      const refund = await tx.refund.findFirst({ where: { id: refundId, userId } });
      if (!refund) throw new DatabaseError("NOT_FOUND", "Refund was not found for this user.");
      if (refund.status === RefundStatus.COMPLETED) return refund;
      if (
        refund.status !== RefundStatus.REQUESTED &&
        refund.status !== RefundStatus.APPROVED &&
        refund.status !== RefundStatus.SUBMITTED
      ) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Refund cannot be completed from its current state.",
        );
      }
      const completed = await tx.refund.update({
        where: { id: refund.id },
        data: { status: RefundStatus.COMPLETED, settledAt: new Date() },
      });
      const aggregate = await tx.refund.aggregate({
        where: { paymentId: refund.paymentId, status: RefundStatus.COMPLETED },
        _sum: { amount: true },
      });
      const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
      if (payment) {
        const totalRefunded = aggregate._sum.amount ?? 0n;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status:
              totalRefunded >= payment.amount
                ? PaymentStatus.REFUNDED
                : PaymentStatus.PARTIALLY_REFUNDED,
          },
        });
      }
      return completed;
    });
  }

  async markRefundFailed(refundId: string, userId: string, failureCode: string) {
    return this.db.refund.updateMany({
      where: {
        id: refundId,
        userId,
        status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.SUBMITTED] },
      },
      data: { status: RefundStatus.FAILED, failureCode: failureCode.trim() || "UNKNOWN" },
    });
  }
}
