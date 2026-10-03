import type { PrismaClient } from "../generated/prisma/client.js";
import {
  MandateStatus,
  PaymentStatus,
  ProposalStatus,
  ReservationStatus,
  ReservationWindow,
} from "../generated/prisma/enums.js";
import { getPrismaClient } from "../client.js";
import { DatabaseError } from "../errors.js";
import { proposalFingerprint } from "../fingerprint.js";
import {
  assertCurrency,
  assertDateRange,
  assertPositiveMinorUnits,
  SUPPORTED_CURRENCY,
} from "../money.js";

export interface ReserveSpendInput {
  userId: string;
  mandateId: string;
  mandateVersionId: string;
  proposalId: string;
  amount: bigint;
  currency?: string;
  window?: ReservationWindow;
  windowStart: Date;
  windowEnd: Date;
  expiresAt: Date;
}

interface SpendPeriod {
  name: ReservationWindow;
  limit: bigint;
  start: Date;
  end: Date;
}

const settleablePaymentStatuses: PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

const existingReservationProposalStatuses: ProposalStatus[] = [
  ProposalStatus.APPROVED,
  ProposalStatus.AUTHORIZED,
  ProposalStatus.PAYPAL_ORDER_CREATED,
  ProposalStatus.PAYMENT_PENDING,
];

function utcPeriod(now: Date, window: ReservationWindow): { start: Date; end: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  if (window === ReservationWindow.DAILY) {
    return {
      start: new Date(Date.UTC(year, month, date)),
      end: new Date(Date.UTC(year, month, date + 1)),
    };
  }
  if (window === ReservationWindow.WEEKLY) {
    const day = now.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(Date.UTC(year, month, date + mondayOffset));
    return {
      start,
      end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7)),
    };
  }
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

function addAmounts(values: readonly { amount: bigint }[]): bigint {
  return values.reduce((sum, value) => sum + value.amount, 0n);
}

function isCaptureInFlight(
  proposalStatus: ProposalStatus,
  paymentStatus: PaymentStatus | null | undefined,
): boolean {
  return (
    proposalStatus === ProposalStatus.PAYMENT_PENDING ||
    paymentStatus === PaymentStatus.CAPTURE_PENDING
  );
}

function isSafeToRelease(
  proposalStatus: ProposalStatus,
  paymentStatus: PaymentStatus | null | undefined,
): boolean {
  if (isCaptureInFlight(proposalStatus, paymentStatus)) return false;
  return (
    paymentStatus === null ||
    paymentStatus === undefined ||
    paymentStatus === PaymentStatus.CREATED ||
    paymentStatus === PaymentStatus.FAILED ||
    paymentStatus === PaymentStatus.DENIED
  );
}

export class SpendRepository {
  constructor(private readonly db: PrismaClient = getPrismaClient()) {}

  async reserve(input: ReserveSpendInput) {
    assertPositiveMinorUnits(input.amount, "reservation amount");
    const requestedCurrency = input.currency ?? SUPPORTED_CURRENCY;
    assertCurrency(requestedCurrency);
    assertDateRange(input.windowStart, input.windowEnd, "reservation window");
    assertDateRange(new Date(), input.expiresAt, "reservation expiry");

    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Mandate" WHERE id = $1 FOR UPDATE',
        input.mandateId,
      );
      const now = new Date();
      const mandate = await tx.mandate.findFirst({
        where: { id: input.mandateId, userId: input.userId },
      });
      if (!mandate) {
        throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
      }
      if (mandate.status !== MandateStatus.ACTIVE) {
        throw new DatabaseError("INVALID_STATE", "Only an active mandate can reserve spend.");
      }
      if (now < mandate.startsAt || now >= mandate.expiresAt) {
        throw new DatabaseError("INVALID_STATE", "Mandate is outside its validity window.");
      }
      if (now < input.windowStart || now >= input.windowEnd) {
        throw new DatabaseError(
          "INVALID_DATE_RANGE",
          "Accounting window must contain the current UTC time.",
        );
      }
      if (input.expiresAt > mandate.expiresAt) {
        throw new DatabaseError(
          "INVALID_DATE_RANGE",
          "Reservation expiry cannot outlive the mandate.",
        );
      }
      assertCurrency(mandate.currency);
      if (requestedCurrency !== mandate.currency) {
        throw new DatabaseError(
          "INVALID_CURRENCY",
          "Reservation currency must match the mandate currency.",
        );
      }
      if (mandate.activeVersionId !== input.mandateVersionId) {
        throw new DatabaseError("CONFLICT", "Reservation must bind to the active mandate version.");
      }
      if (input.amount > mandate.transactionLimit) {
        throw new DatabaseError(
          "LIMIT_EXCEEDED",
          "Reservation exceeds the mandate transaction limit.",
        );
      }

      const [version, proposal] = await Promise.all([
        tx.mandateVersion.findFirst({
          where: { id: input.mandateVersionId, mandateId: input.mandateId },
        }),
        tx.purchaseProposal.findFirst({
          where: {
            id: input.proposalId,
            userId: input.userId,
            mandateId: input.mandateId,
            mandateVersionId: input.mandateVersionId,
          },
          include: { payment: true },
        }),
      ]);
      if (!version || !proposal) {
        throw new DatabaseError(
          "NOT_FOUND",
          "Reservation proposal or mandate version was not found.",
        );
      }
      if (proposal.total !== input.amount || proposal.currency !== requestedCurrency) {
        throw new DatabaseError(
          "CONFLICT",
          "Reservation amount and currency must match the immutable proposal.",
        );
      }
      if (proposal.expiresAt && now >= proposal.expiresAt) {
        throw new DatabaseError("INVALID_STATE", "The purchase proposal has expired.");
      }
      const expectedFingerprint = proposalFingerprint({
        userId: proposal.userId,
        mandateId: proposal.mandateId,
        mandateVersionId: proposal.mandateVersionId,
        productSnapshotId: proposal.productSnapshotId,
        quantity: proposal.quantity,
        subtotal: proposal.subtotal,
        shipping: proposal.shipping,
        tax: proposal.tax,
        total: proposal.total,
        currency: proposal.currency,
      });
      if (proposal.proposalFingerprint !== expectedFingerprint) {
        throw new DatabaseError(
          "CONFLICT",
          "Proposal fingerprint no longer matches its immutable facts.",
        );
      }
      if (!existingReservationProposalStatuses.includes(proposal.status)) {
        throw new DatabaseError("INVALID_STATE", "Proposal is not eligible for spend reservation.");
      }
      const isNewReservation =
        proposal.status === ProposalStatus.APPROVED ||
        proposal.status === ProposalStatus.AUTHORIZED;

      const existing = await tx.spendReservation.findUnique({
        where: { proposalId: input.proposalId },
      });
      if (existing) {
        if (
          existing.amount !== input.amount ||
          existing.currency !== requestedCurrency ||
          existing.mandateVersionId !== input.mandateVersionId
        ) {
          throw new DatabaseError(
            "CONFLICT",
            "Proposal already has a different spend reservation.",
          );
        }
        if (existing.status === ReservationStatus.ACTIVE) {
          if (
            existing.expiresAt <= now &&
            !isCaptureInFlight(proposal.status, proposal.payment?.status)
          ) {
            await tx.spendReservation.update({
              where: { id: existing.id },
              data: { status: ReservationStatus.EXPIRED, releasedAt: now },
            });
            throw new DatabaseError(
              "RESERVATION_EXPIRED",
              "The proposal's previous reservation is no longer active.",
            );
          }
          return existing;
        }
        if (existing.status === ReservationStatus.CONSUMED) {
          throw new DatabaseError("INVALID_STATE", "A consumed reservation cannot be reused.");
        }
        throw new DatabaseError(
          "RESERVATION_EXPIRED",
          "The proposal's previous reservation is no longer active.",
        );
      }
      if (!isNewReservation) {
        throw new DatabaseError(
          "INVALID_STATE",
          "Only an approved or authorized proposal can create a reservation.",
        );
      }

      const staleReservations = await tx.spendReservation.findMany({
        where: {
          mandateId: mandate.id,
          status: ReservationStatus.ACTIVE,
          expiresAt: { lte: now },
        },
        include: { proposal: { include: { payment: true } } },
      });
      for (const stale of staleReservations) {
        if (!isCaptureInFlight(stale.proposal.status, stale.proposal.payment?.status)) {
          await tx.spendReservation.update({
            where: { id: stale.id },
            data: { status: ReservationStatus.EXPIRED, releasedAt: now },
          });
        }
      }

      const periods: SpendPeriod[] = [];
      if (mandate.dailyLimit !== null) {
        const period = utcPeriod(now, ReservationWindow.DAILY);
        periods.push({ name: ReservationWindow.DAILY, limit: mandate.dailyLimit, ...period });
      }
      if (mandate.weeklyLimit !== null) {
        const period = utcPeriod(now, ReservationWindow.WEEKLY);
        periods.push({ name: ReservationWindow.WEEKLY, limit: mandate.weeklyLimit, ...period });
      }
      if (mandate.monthlyLimit !== null) {
        const period = utcPeriod(now, ReservationWindow.MONTHLY);
        periods.push({ name: ReservationWindow.MONTHLY, limit: mandate.monthlyLimit, ...period });
      }

      for (const period of periods) {
        const [reservations, payments] = await Promise.all([
          tx.spendReservation.findMany({
            where: {
              mandateId: mandate.id,
              currency: mandate.currency,
              status: ReservationStatus.ACTIVE,
              proposalId: { not: input.proposalId },
            },
            select: { amount: true },
          }),
          tx.payment.findMany({
            where: {
              mandateId: mandate.id,
              currency: mandate.currency,
              status: { in: settleablePaymentStatuses },
              capturedAt: { gte: period.start, lt: period.end },
            },
            select: { amount: true },
          }),
        ]);
        const committed = addAmounts(reservations) + addAmounts(payments);
        if (committed + input.amount > period.limit) {
          throw new DatabaseError(
            "LIMIT_EXCEEDED",
            period.name + " spending limit would be exceeded.",
            {
              limit: period.limit.toString(),
              committed: committed.toString(),
              requested: input.amount.toString(),
            },
          );
        }
      }

      return tx.spendReservation.create({
        data: {
          mandateId: mandate.id,
          mandateVersionId: version.id,
          proposalId: proposal.id,
          amount: input.amount,
          currency: mandate.currency,
          window: input.window ?? ReservationWindow.TRANSACTION,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          status: ReservationStatus.ACTIVE,
          expiresAt: input.expiresAt,
        },
      });
    });
  }

  async getForUser(reservationId: string, userId: string) {
    const reservation = await this.db.spendReservation.findFirst({
      where: { id: reservationId, proposal: { userId } },
      include: { proposal: true, mandateVersion: true },
    });
    if (!reservation) {
      throw new DatabaseError("NOT_FOUND", "Spend reservation was not found for this user.");
    }
    return reservation;
  }

  async release(proposalId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM "SpendReservation" WHERE "proposalId" = $1 FOR UPDATE',
        proposalId,
      );
      const reservation = await tx.spendReservation.findFirst({
        where: { proposalId, proposal: { userId } },
        include: { proposal: { include: { payment: true } } },
      });
      if (!reservation) {
        throw new DatabaseError("NOT_FOUND", "Spend reservation was not found for this user.");
      }
      if (!isSafeToRelease(reservation.proposal.status, reservation.proposal.payment?.status)) {
        throw new DatabaseError(
          "INVALID_STATE",
          "A reservation with an unknown or in-flight provider outcome cannot be released.",
        );
      }
      if (
        reservation.status === ReservationStatus.RELEASED ||
        reservation.status === ReservationStatus.EXPIRED
      ) {
        return reservation;
      }
      if (reservation.status === ReservationStatus.CONSUMED) {
        throw new DatabaseError("INVALID_STATE", "A consumed reservation cannot be released.");
      }
      return tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
      });
    });
  }

  async consume(proposalId: string, userId: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM "SpendReservation" WHERE "proposalId" = $1 FOR UPDATE',
        proposalId,
      );
      const reservation = await tx.spendReservation.findFirst({
        where: { proposalId, proposal: { userId } },
      });
      if (!reservation) {
        throw new DatabaseError("NOT_FOUND", "Spend reservation was not found for this user.");
      }
      if (reservation.status === ReservationStatus.CONSUMED) return reservation;
      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new DatabaseError("INVALID_STATE", "Only an active reservation can be consumed.");
      }
      return tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.CONSUMED, consumedAt: new Date() },
      });
    });
  }
}
