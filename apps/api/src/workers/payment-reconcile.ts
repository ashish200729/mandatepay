import { randomUUID } from "node:crypto";
import {
  AuditEntityType,
  AuditEventType,
  ObservabilityRepository,
  PaymentSource,
  PaymentStatus,
  ProposalStatus,
  ReservationStatus,
  createPrismaClient,
  type DatabaseClient,
} from "@mandatepay/database";
import type { WorkerRunCounts } from "@mandatepay/shared";
import {
  CAPTURE_PENDING_STALE_MS,
  VAULT_ORDER_REPLAY_WINDOW_MS,
  createPayPalClientFromEnvironment,
  reconcilePaypalOrder,
  replayUnboundVaultOrder,
  type PayPalGateway,
  type PaymentServiceContext,
} from "../services/payments.js";
import { createVaultCipher, type VaultCipher } from "../services/vault-crypto.js";

export const PAYMENT_RECONCILE_WORKER = "paypal-payment-reconcile" as const;
export const PAYMENT_RECONCILE_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;

const settledStatuses: readonly PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.REVERSED,
];

export interface PaymentReconcileOptions {
  /** Only CAPTURE_PENDING payments unchanged for at least this long are examined. */
  readonly staleAfterMs?: number;
  readonly batchSize?: number;
  /** Restricts a run to these owners (operator or test scoping). */
  readonly userIds?: readonly string[];
  /** Decrypts saved Vault tokens; without it unbound Vault payments are held, never replayed. */
  readonly vault?: VaultCipher | null;
  /** Maximum claim age for replaying an unbound Vault order request. */
  readonly vaultReplayWindowMs?: number;
}

export interface PaymentReconcileRunResult extends WorkerRunCounts {
  readonly captures: {
    readonly completed: number;
    readonly failed: number;
    readonly returnedToPayer: number;
    readonly stillPending: number;
    readonly errors: number;
  };
  readonly vaultReplays: {
    readonly completed: number;
    readonly failed: number;
    readonly returnedToPayer: number;
    readonly stillPending: number;
    /** Kept pending without a PayPal call; surfaced in System health. */
    readonly held: number;
    readonly errors: number;
  };
  readonly reservationsReleased: number;
}

/**
 * Resolves uncertain captures and abandoned spending holds:
 *  (a) CAPTURE_PENDING payments with a PayPal order older than the stale
 *      window are reconciled from PayPal reads (order and capture) only;
 *  (b) stale autonomous (Vault) CAPTURE_PENDING payments whose create-order
 *      outcome was unknown, so they have no order id, replay the same
 *      idempotent create-order request (same PayPal-Request-Id). PayPal returns
 *      the original order for a repeated request ID, so this never creates a
 *      second charge. The replay runs only while the saved method, account,
 *      platform and autonomy switches and mandate still allow it and inside
 *      the replay window; otherwise the payment is held pending with its
 *      reservation (it may already be charged) and counted for operators;
 *  (c) expired ACTIVE reservations of unpaid proposals are released, while
 *      every hold that may still be captured is kept.
 * Every state change re-checks state under User -> Mandate -> Proposal ->
 * Payment row locks, so concurrent runs are safe; a duplicate run only
 * repeats provider reads or the same idempotent request.
 */
export class PaymentReconcileWorker {
  constructor(
    private readonly database: DatabaseClient,
    private readonly paypal: PayPalGateway,
    private readonly options: PaymentReconcileOptions = {},
  ) {}

  async runOnce(now = new Date()): Promise<PaymentReconcileRunResult> {
    const runId = randomUUID();
    const heartbeats = new ObservabilityRepository(this.database);
    const zero: WorkerRunCounts = {
      scanned: 0,
      claimed: 0,
      processed: 0,
      ignored: 0,
      pending: 0,
      exhausted: 0,
    };
    await heartbeats.beginWorkerRun({ runId, at: now, worker: PAYMENT_RECONCILE_WORKER });
    try {
      const captures = await this.reconcileCaptures(now);
      const vault = await this.replayUnboundVaultOrders(now);
      const reservations = await this.releaseExpiredReservations(now);
      const counts: WorkerRunCounts = {
        scanned: captures.scanned + vault.scanned + reservations.scanned,
        claimed: captures.scanned + vault.scanned,
        processed:
          captures.completed +
          captures.failed +
          captures.returnedToPayer +
          vault.completed +
          vault.failed +
          vault.returnedToPayer +
          reservations.released,
        ignored: reservations.scanned - reservations.released,
        pending:
          captures.stillPending + captures.errors + vault.stillPending + vault.held + vault.errors,
        exhausted: 0,
      };
      await heartbeats.finishWorkerRun({
        runId,
        at: new Date(),
        outcome: "SUCCEEDED",
        counts,
        worker: PAYMENT_RECONCILE_WORKER,
      });
      return {
        ...counts,
        captures: {
          completed: captures.completed,
          failed: captures.failed,
          returnedToPayer: captures.returnedToPayer,
          stillPending: captures.stillPending,
          errors: captures.errors,
        },
        vaultReplays: {
          completed: vault.completed,
          failed: vault.failed,
          returnedToPayer: vault.returnedToPayer,
          stillPending: vault.stillPending,
          held: vault.held,
          errors: vault.errors,
        },
        reservationsReleased: reservations.released,
      };
    } catch {
      try {
        await heartbeats.finishWorkerRun({
          runId,
          at: new Date(),
          outcome: "FAILED",
          counts: zero,
          worker: PAYMENT_RECONCILE_WORKER,
        });
      } catch {
        // Report the run failure without a second error or any payload.
      }
      throw new Error("Payment reconciliation failed.");
    }
  }

  private batchSize() {
    const value = this.options.batchSize ?? PAYMENT_RECONCILE_BATCH_SIZE;
    return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value)));
  }

  private ownerScope() {
    return this.options.userIds ? { userId: { in: [...this.options.userIds] } } : {};
  }

  private context(): PaymentServiceContext {
    return {
      database: this.database,
      paypal: this.paypal,
      appUrl: "https://127.0.0.1",
      lookupDemoProduct: async () => null,
      vault: this.options.vault ?? null,
    };
  }

  private async replayUnboundVaultOrders(now: Date) {
    const staleAfterMs = this.options.staleAfterMs ?? CAPTURE_PENDING_STALE_MS;
    const replayWindowMs = this.options.vaultReplayWindowMs ?? VAULT_ORDER_REPLAY_WINDOW_MS;
    // Claims past the replay window are never replayed; leaving them out keeps
    // them from crowding replayable payments out of the batch. System health
    // still counts them for an operator.
    const candidates = await this.database.payment.findMany({
      where: {
        ...this.ownerScope(),
        status: PaymentStatus.CAPTURE_PENDING,
        paymentSource: PaymentSource.VAULT,
        paypalOrderId: null,
        isSample: false,
        proposal: { isSample: false },
        createdAt: { gte: new Date(now.getTime() - replayWindowMs) },
        updatedAt: { lte: new Date(now.getTime() - staleAfterMs) },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: this.batchSize(),
      select: { id: true, userId: true },
    });
    const context = this.context();
    const result = {
      scanned: candidates.length,
      completed: 0,
      failed: 0,
      returnedToPayer: 0,
      stillPending: 0,
      held: 0,
      errors: 0,
    };
    for (const candidate of candidates) {
      try {
        const replay = await replayUnboundVaultOrder(
          context,
          { id: candidate.userId },
          candidate.id,
          {
            now,
            replayWindowMs,
          },
        );
        const outcome = replay.result.outcome;
        if (replay.heldReason !== null) result.held += 1;
        else if (outcome === "PAID") result.completed += 1;
        else if (outcome === "FAILED") result.failed += 1;
        else if (outcome === "FALLBACK") result.returnedToPayer += 1;
        else result.stillPending += 1;
      } catch {
        // One payment's provider or data error must not stop the batch.
        result.errors += 1;
      }
    }
    return result;
  }

  private async reconcileCaptures(now: Date) {
    const staleAfterMs = this.options.staleAfterMs ?? CAPTURE_PENDING_STALE_MS;
    const candidates = await this.database.payment.findMany({
      where: {
        ...this.ownerScope(),
        status: PaymentStatus.CAPTURE_PENDING,
        isSample: false,
        proposal: { isSample: false },
        paypalOrderId: { not: null },
        updatedAt: { lte: new Date(now.getTime() - staleAfterMs) },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: this.batchSize(),
      select: { id: true, userId: true },
    });
    const context = this.context();
    const result = {
      scanned: candidates.length,
      completed: 0,
      failed: 0,
      returnedToPayer: 0,
      stillPending: 0,
      errors: 0,
    };
    for (const candidate of candidates) {
      try {
        const outcome = await reconcilePaypalOrder(
          context,
          { id: candidate.userId },
          candidate.id,
          { staleAfterMs, now },
        );
        const status = outcome.payment.status;
        if (settledStatuses.includes(status)) result.completed += 1;
        else if (status === PaymentStatus.FAILED || status === PaymentStatus.DENIED)
          result.failed += 1;
        else if (status === PaymentStatus.APPROVED || status === PaymentStatus.CREATED)
          result.returnedToPayer += 1;
        else result.stillPending += 1;
      } catch {
        // One payment's provider or data error must not stop the batch.
        result.errors += 1;
      }
    }
    return result;
  }

  private async releaseExpiredReservations(now: Date) {
    const candidates = await this.database.spendReservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        isSample: false,
        expiresAt: { lte: now },
        proposal: {
          isSample: false,
          status: { not: ProposalStatus.PAYMENT_PENDING },
          ...this.ownerScope(),
        },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: this.batchSize(),
      select: { id: true },
    });
    let released = 0;
    for (const candidate of candidates) {
      if (await this.releaseReservation(candidate.id, now)) released += 1;
    }
    return { scanned: candidates.length, released };
  }

  private async releaseReservation(reservationId: string, now: Date): Promise<boolean> {
    return this.database.$transaction(async (tx) => {
      const unlocked = await tx.spendReservation.findUnique({
        where: { id: reservationId },
        select: { mandateId: true, proposalId: true, proposal: { select: { userId: true } } },
      });
      if (!unlocked) return false;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${unlocked.proposal.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${unlocked.mandateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${unlocked.proposalId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "proposalId" = ${unlocked.proposalId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "SpendReservation" WHERE id = ${reservationId} FOR UPDATE`;
      const reservation = await tx.spendReservation.findUnique({
        where: { id: reservationId },
        include: { proposal: { include: { payment: true } } },
      });
      if (
        !reservation ||
        reservation.status !== ReservationStatus.ACTIVE ||
        reservation.isSample ||
        reservation.expiresAt > now
      ) {
        return false;
      }
      const payment = reservation.proposal.payment;
      // Keep every hold that a capture may still consume.
      if (
        reservation.proposal.status === ProposalStatus.PAYMENT_PENDING ||
        payment?.status === PaymentStatus.CAPTURE_PENDING ||
        payment?.paypalCaptureId ||
        (payment && settledStatuses.includes(payment.status))
      ) {
        return false;
      }
      await tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.EXPIRED, releasedAt: now },
      });
      await tx.auditEvent.create({
        data: {
          userId: reservation.proposal.userId,
          eventType: AuditEventType.SPEND_RESERVATION_RELEASED,
          entityType: AuditEntityType.SPEND_RESERVATION,
          entityId: reservation.id,
          // Same key as the policy path, so a hold is released exactly once.
          dedupeKey: `expired-reservation:${reservation.id}`,
          payload: {
            reason: "AUTHORIZATION_EXPIRED",
            proposalId: reservation.proposalId,
            source: PAYMENT_RECONCILE_WORKER,
          },
        },
      });
      return true;
    });
  }
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Payment reconcile worker configuration is invalid.");
  }
  return parsed;
}

export async function runPaymentReconcileOnce(env: NodeJS.ProcessEnv = process.env) {
  const staleMinutes = boundedInteger(env.PAYMENT_RECONCILE_STALE_MINUTES, 10, 1, 1_440);
  const batchSize = boundedInteger(
    env.PAYMENT_RECONCILE_BATCH_SIZE,
    PAYMENT_RECONCILE_BATCH_SIZE,
    1,
    MAX_BATCH_SIZE,
  );
  const paypal = createPayPalClientFromEnvironment({
    PAYPAL_ENV: env.PAYPAL_ENV,
    PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID,
  });
  if (!paypal) throw new Error("PayPal configuration is required for payment reconciliation.");
  const database = createPrismaClient(env.DATABASE_URL);
  try {
    return await new PaymentReconcileWorker(database, paypal, {
      staleAfterMs: staleMinutes * 60_000,
      batchSize,
      // Missing or invalid key: unbound Vault payments are held, never replayed.
      vault: createVaultCipher(env.TOKEN_ENCRYPTION_KEY),
    }).runOnce();
  } finally {
    await database.$disconnect();
  }
}

if (process.argv[1]?.endsWith("payment-reconcile.js")) {
  try {
    console.info(
      JSON.stringify({
        event: "payment_reconcile_completed",
        ...(await runPaymentReconcileOnce()),
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: "payment_reconcile_failed" }));
    process.exitCode = 1;
  }
}
