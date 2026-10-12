import type { Prisma } from "@mandatepay/database";
import {
  AuditEntityType,
  AuditEventType,
  PaymentSource,
  PaymentStatus,
  ProposalStatus,
  RefundStatus,
  ReservationStatus,
  type DatabaseClient,
  type Prisma as PrismaNamespace,
} from "@mandatepay/database";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PENDING_MAX_ATTEMPTS,
  WebhookProcessingStatus,
} from "@mandatepay/database";
import {
  PayPalClient,
  PayPalWebhookService,
  type AuthoritativeWebhookData,
  type WebhookInboxClaim,
  type WebhookInboxStore,
  type PayPalWebhookReconciler,
} from "@mandatepay/paypal";
import {
  PayPalCaptureSchema,
  parseProviderMoney,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalRefund,
} from "@mandatepay/paypal";
import type { PayPalWebhookEvent } from "@mandatepay/paypal";
import { reconcileVaultTokenEvent } from "./payment-methods.js";
import { createVaultCipher, type VaultCipher } from "./vault-crypto.js";

type PaymentAuthoritativeData = Exclude<AuthoritativeWebhookData, { kind: "payment_token" }>;

const PROCESSING_LEASE_MS = 5 * 60_000;

function jsonPayload(event: PayPalWebhookEvent): Prisma.InputJsonValue {
  return event as unknown as Prisma.InputJsonValue;
}

export interface VerifiedWebhookRecoveryCandidate {
  readonly id: string;
  readonly attempts: number;
  readonly awaitingProvider: boolean;
  readonly payload: unknown;
}

/**
 * Per-row retry ceilings: events waiting on provider state retry for days on
 * a long schedule; events whose processing failed keep the short policy.
 */
export interface WebhookRetryLimits {
  readonly failed: number;
  readonly pending: number;
}

export const DEFAULT_WEBHOOK_RETRY_LIMITS: WebhookRetryLimits = {
  failed: WEBHOOK_MAX_ATTEMPTS,
  pending: WEBHOOK_PENDING_MAX_ATTEMPTS,
};

function remainingWhere(limits: WebhookRetryLimits): PrismaNamespace.WebhookInboxWhereInput {
  return {
    OR: [
      { awaitingProvider: false, attempts: { lt: limits.failed } },
      { awaitingProvider: true, attempts: { lt: limits.pending } },
    ],
  };
}

export function webhookRowLimit(
  row: { awaitingProvider: boolean },
  limits: WebhookRetryLimits = DEFAULT_WEBHOOK_RETRY_LIMITS,
) {
  return row.awaitingProvider ? limits.pending : limits.failed;
}

export class PrismaWebhookInboxStore implements WebhookInboxStore {
  constructor(private readonly db: DatabaseClient) {}

  async claim(input: {
    provider: "paypal";
    providerEventId: string;
    eventType: string;
    payload: PayPalWebhookEvent;
  }): Promise<WebhookInboxClaim> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.provider + ":" + input.providerEventId}))`;
      const existing = await tx.webhookInbox.findUnique({
        where: {
          provider_providerEventId: {
            provider: input.provider,
            providerEventId: input.providerEventId,
          },
        },
      });

      if (existing) {
        if (existing.status === "PROCESSED" || existing.status === "IGNORED") {
          return { id: existing.id, shouldProcess: false, status: existing.status };
        }
        if (existing.status === "PROCESSING") {
          if (Date.now() - existing.updatedAt.getTime() < PROCESSING_LEASE_MS) {
            return { id: existing.id, shouldProcess: false, status: existing.status };
          }
          const reclaimed = await tx.webhookInbox.update({
            where: { id: existing.id },
            data: {
              status: "PROCESSING",
              attempts: { increment: 1 },
              lastError: "Reclaimed an expired processing lease.",
              nextAttemptAt: null,
              signatureVerified: true,
            },
          });
          return { id: reclaimed.id, shouldProcess: true, status: "PROCESSING" };
        }
        const claimed = await tx.webhookInbox.update({
          where: { id: existing.id },
          data: {
            status: "PROCESSING",
            attempts: { increment: 1 },
            lastError: null,
            nextAttemptAt: null,
            signatureVerified: true,
          },
        });
        return { id: claimed.id, shouldProcess: true, status: "PROCESSING" };
      }

      const created = await tx.webhookInbox.create({
        data: {
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          signatureVerified: true,
          payload: jsonPayload(input.payload),
          status: "PROCESSING",
          attempts: 1,
        },
      });
      return { id: created.id, shouldProcess: true, status: "PROCESSING" };
    });
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null, nextAttemptAt: null },
    });
  }

  /** Provider state is not ready: the recovery worker retries on the pending schedule. */
  async markPending(id: string, reason: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: {
        status: "FAILED",
        lastError: reason.slice(0, 10_000),
        nextAttemptAt: null,
        awaitingProvider: true,
      },
    });
  }

  /** Processing failed: the recovery worker retries on the failure schedule. */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: { status: "FAILED", lastError: reason.slice(0, 10_000), nextAttemptAt: null },
    });
  }

  async markIgnored(id: string, reason: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: { status: "IGNORED", lastError: reason.slice(0, 10_000), nextAttemptAt: null },
    });
  }

  async listRecoveryCandidates(
    now: Date,
    limits: WebhookRetryLimits,
    leaseMs: number,
    take: number,
  ) {
    const leaseCutoff = new Date(now.getTime() - leaseMs);
    return this.db.webhookInbox.findMany({
      where: {
        provider: "paypal",
        signatureVerified: true,
        AND: [remainingWhere(limits)],
        OR: [
          {
            status: WebhookProcessingStatus.FAILED,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          { status: WebhookProcessingStatus.PROCESSING, updatedAt: { lte: leaseCutoff } },
        ],
      },
      orderBy: [{ nextAttemptAt: "asc" }, { receivedAt: "asc" }],
      take,
      select: { id: true },
    });
  }

  async claimVerifiedForReplay(
    id: string,
    now: Date,
    limits: WebhookRetryLimits,
    leaseMs: number,
  ): Promise<VerifiedWebhookRecoveryCandidate | null> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookInbox" WHERE id = ${id} FOR UPDATE`;
      const row = await tx.webhookInbox.findUnique({ where: { id } });
      if (
        !row ||
        row.provider !== "paypal" ||
        !row.signatureVerified ||
        row.attempts >= webhookRowLimit(row, limits)
      ) {
        return null;
      }
      const leaseCutoff = new Date(now.getTime() - leaseMs);
      const due =
        (row.status === WebhookProcessingStatus.FAILED &&
          (row.nextAttemptAt === null || row.nextAttemptAt <= now)) ||
        (row.status === WebhookProcessingStatus.PROCESSING && row.updatedAt <= leaseCutoff);
      if (!due) return null;
      const claimed = await tx.webhookInbox.update({
        where: { id },
        data: {
          status: WebhookProcessingStatus.PROCESSING,
          attempts: { increment: 1 },
          lastError: null,
          nextAttemptAt: null,
        },
      });
      return {
        id: claimed.id,
        attempts: claimed.attempts,
        awaitingProvider: claimed.awaitingProvider,
        payload: claimed.payload,
      };
    });
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: Date | null,
    reason: string,
    options: { awaitingProvider?: boolean } = {},
  ): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: {
        status: WebhookProcessingStatus.FAILED,
        nextAttemptAt,
        lastError: reason.slice(0, 10_000),
        ...(options.awaitingProvider === undefined
          ? {}
          : { awaitingProvider: options.awaitingProvider }),
      },
    });
  }
}

type PaymentWithBindings = Awaited<ReturnType<PrismaWebhookReconcilerImpl["findPayment"]>>;
type TransactionClient = PrismaNamespace.TransactionClient;

function relatedId(resource: Record<string, unknown>, key: string): string | null {
  const supplementary = resource.supplementary_data;
  const supplementaryRecord =
    typeof supplementary === "object" && supplementary !== null && !Array.isArray(supplementary)
      ? (supplementary as Record<string, unknown>)
      : null;
  const related = supplementaryRecord?.related_ids;
  const relatedRecord =
    typeof related === "object" && related !== null && !Array.isArray(related)
      ? (related as Record<string, unknown>)
      : null;
  const value = relatedRecord?.[key] ?? resource[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function relatedOrderId(resource: Record<string, unknown>): string | null {
  return relatedId(resource, "order_id");
}

function relatedCaptureId(resource: Record<string, unknown>): string | null {
  return relatedId(resource, "capture_id");
}

function providerResourceTimestamp(resource: unknown): Date | null {
  const record =
    typeof resource === "object" && resource !== null && !Array.isArray(resource)
      ? (resource as Record<string, unknown>)
      : null;
  const value =
    (typeof record?.create_time === "string" && record.create_time) ||
    (typeof record?.update_time === "string" && record.update_time);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function customIdMatches(
  payment: NonNullable<PaymentWithBindings>,
  customIds: readonly string[],
): boolean {
  return customIds.length > 0 && customIds.some((value) => value === payment.proposalId);
}

function orderCustomIds(order: PayPalOrder): string[] {
  return (order.purchase_units ?? [])
    .map((unit) => unit.custom_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function captureCustomIds(capture: PayPalCapture): string[] {
  return capture.custom_id ? [capture.custom_id] : [];
}

function orderBindingMatches(
  payment: NonNullable<PaymentWithBindings>,
  order: PayPalOrder,
): boolean {
  if (order.purchase_units?.length !== 1) return false;
  const unit = order.purchase_units[0];
  if (!unit || unit.reference_id !== payment.id || unit.custom_id !== payment.proposalId)
    return false;
  if (!unit.amount || unit.amount.currency_code !== "USD") return false;
  try {
    return BigInt(parseProviderMoney(unit.amount)) === payment.amount;
  } catch {
    return false;
  }
}

function orderCaptureMatches(order: PayPalOrder, capture: PayPalCapture): boolean {
  if (order.purchase_units?.length !== 1) return false;
  const unit = order.purchase_units[0] as Record<string, unknown>;
  const payments = unit.payments;
  if (typeof payments !== "object" || payments === null || Array.isArray(payments)) return false;
  const captures = (payments as { captures?: unknown }).captures;
  if (!Array.isArray(captures) || captures.length !== 1) return false;
  const providerCapture = captures[0];
  return (
    typeof providerCapture === "object" &&
    providerCapture !== null &&
    !Array.isArray(providerCapture) &&
    (providerCapture as { id?: unknown }).id === capture.id
  );
}

const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.REVERSED,
];
const SAFE_REASON = /^[A-Z0-9_]{1,64}$/u;

function safeReason(value: unknown): string | null {
  return typeof value === "string" && SAFE_REASON.test(value) ? value : null;
}

class PrismaWebhookReconcilerImpl implements PayPalWebhookReconciler {
  constructor(
    private readonly db: DatabaseClient,
    private readonly vault: VaultCipher | null = null,
  ) {}

  async findPayment(authoritative: PaymentAuthoritativeData) {
    const orderId =
      authoritative.kind === "order" ? authoritative.order.id : (authoritative.order?.id ?? null);
    const captureId = authoritative.kind === "order" ? null : (authoritative.capture?.id ?? null);
    const payments = await this.db.payment.findMany({
      where: {
        isSample: false,
        proposal: { isSample: false },
        OR: [
          ...(orderId ? [{ paypalOrderId: orderId }] : []),
          ...(captureId ? [{ paypalCaptureId: captureId }] : []),
        ],
      },
      include: {
        proposal: { include: { productSnapshot: true, reservation: true } },
        refunds: { where: { isSample: false } },
      },
    });
    if (payments.length === 1) return payments[0];
    if (payments.length > 1) return null;
    // A Vault order whose create response was lost is not bound locally yet.
    // PayPal's own order carries our payment id (reference_id) and proposal id
    // (custom_id); the binding is re-checked under the payment lock.
    const unit =
      authoritative.order?.purchase_units?.length === 1
        ? authoritative.order.purchase_units[0]
        : undefined;
    if (!unit?.reference_id || !unit.custom_id) return null;
    return (
      (await this.db.payment.findFirst({
        where: {
          id: unit.reference_id,
          proposalId: unit.custom_id,
          paypalOrderId: null,
          paymentSource: PaymentSource.VAULT,
          isSample: false,
          proposal: { isSample: false },
        },
        include: {
          proposal: { include: { productSnapshot: true, reservation: true } },
          refunds: { where: { isSample: false } },
        },
      })) ?? null
    );
  }

  async reconcile(input: {
    event: PayPalWebhookEvent;
    authoritative: AuthoritativeWebhookData;
  }): Promise<"processed" | "pending" | "ignored"> {
    if (input.authoritative.kind === "payment_token") {
      return reconcileVaultTokenEvent(this.db, this.vault, input.event, input.authoritative);
    }
    const authoritative = input.authoritative;
    const candidate = await this.findPayment(authoritative);
    if (!candidate) return "ignored";

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${candidate.mandateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${candidate.proposalId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${candidate.id} FOR UPDATE`;
      let payment = await tx.payment.findUnique({
        where: { id: candidate.id },
        include: {
          proposal: { include: { productSnapshot: true, reservation: true } },
          refunds: { where: { isSample: false } },
        },
      });
      if (!payment) return "ignored";
      if (!payment.paypalOrderId) {
        // Only an unbound Vault payment reaches here; bind it to PayPal's order
        // when that order names this payment, proposal and amount exactly.
        const order = authoritative.order;
        if (
          payment.paymentSource !== PaymentSource.VAULT ||
          !order ||
          !orderBindingMatches(payment, order)
        ) {
          return "ignored";
        }
        payment = await tx.payment.update({
          where: { id: payment.id },
          data: { paypalOrderId: order.id },
          include: {
            proposal: { include: { productSnapshot: true, reservation: true } },
            refunds: { where: { isSample: false } },
          },
        });
        await tx.auditEvent.create({
          data: {
            userId: payment.userId,
            eventType: AuditEventType.PAYPAL_ORDER_CREATED,
            entityType: AuditEntityType.PAYMENT,
            entityId: payment.id,
            dedupeKey: `paypal-order-created:${payment.id}`,
            payload: {
              paymentId: payment.id,
              proposalId: payment.proposalId,
              paypalOrderId: order.id,
              amount: Number(payment.amount),
              currency: payment.currency,
              source: "verified_webhook",
            },
          },
        });
      }

      switch (authoritative.kind) {
        case "order":
          return this.reconcileOrder(tx, payment, input.event, authoritative.order);
        case "capture":
          return this.reconcileCapture(
            tx,
            payment,
            input.event,
            authoritative.capture,
            authoritative.order,
          );
        case "refund":
          return this.reconcileRefund(
            tx,
            payment,
            input.event,
            authoritative.refund,
            authoritative.capture,
            authoritative.order,
          );
        case "reversal":
          return this.reconcileReversal(
            tx,
            payment,
            input.event,
            authoritative.capture,
            authoritative.refund,
            authoritative.order,
          );
      }
    });
  }

  private async reconcileOrder(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    order: PayPalOrder,
  ): Promise<"processed" | "pending" | "ignored"> {
    const eventResourceId = typeof event.resource.id === "string" ? event.resource.id : null;
    if (!eventResourceId || eventResourceId !== order.id) return "ignored";
    if (payment.paypalOrderId !== order.id) return "ignored";
    if (!orderBindingMatches(payment, order)) return "ignored";
    if (order.status !== "APPROVED" && order.status !== "COMPLETED") return "pending";
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) return "processed";
    if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
      return order.status === "COMPLETED" ? "pending" : "processed";
    }
    if (order.status === "COMPLETED") {
      // CHECKOUT.ORDER.COMPLETED: settle from the order's own authoritative capture.
      const capture = singleOrderCapture(order);
      if (!capture) return "pending";
      if (capture.status === "PENDING") {
        return this.recordPendingCapture(tx, payment, event, capture);
      }
      if (capture.status !== "COMPLETED") return "pending";
      return this.completeCapture(tx, payment, event, capture, order);
    }
    if (payment.status !== PaymentStatus.CREATED && payment.status !== PaymentStatus.APPROVED) {
      return "pending";
    }
    if (payment.status === PaymentStatus.CREATED) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.APPROVED, providerStatusReason: null, payerActionUrl: null },
      });
      await this.audit(tx, payment, event, AuditEventType.PAYPAL_ORDER_APPROVED, {
        paypalOrderId: order.id,
      });
    }
    return "processed";
  }

  private async reconcileCapture(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    capture: PayPalCapture,
    order: PayPalOrder | null,
  ): Promise<"processed" | "pending" | "ignored"> {
    const eventResourceId = typeof event.resource.id === "string" ? event.resource.id : null;
    if (!eventResourceId || eventResourceId !== capture.id) return "ignored";
    const eventOrderId = relatedOrderId(event.resource);
    const eventCaptureId = relatedCaptureId(event.resource);
    if (!order || !orderBindingMatches(payment, order) || !orderCaptureMatches(order, capture)) {
      return "pending";
    }
    if (eventOrderId && (!order || eventOrderId !== order.id)) return "ignored";
    if (eventCaptureId && eventCaptureId !== capture.id) return "ignored";
    if (order && payment.paypalOrderId !== order.id) return "ignored";
    const customIds = [...captureCustomIds(capture), ...(order ? orderCustomIds(order) : [])];
    if (!customIdMatches(payment, customIds)) return "ignored";
    let amount: bigint;
    try {
      amount = BigInt(parseProviderMoney(capture.amount));
    } catch {
      return "ignored";
    }
    if (amount !== payment.amount || payment.currency !== "USD") return "ignored";
    const providerTime = providerResourceTimestamp(capture);
    if (!providerTime) return "pending";

    if (event.event_type === "PAYMENT.CAPTURE.DENIED") {
      if (capture.status !== "DECLINED" && capture.status !== "FAILED") return "pending";
      if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) return "ignored";
      if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
        return "processed";
      }
      if (
        payment.status !== PaymentStatus.CREATED &&
        payment.status !== PaymentStatus.APPROVED &&
        payment.status !== PaymentStatus.CAPTURE_PENDING
      ) {
        return "pending";
      }
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.DENIED,
          failureCode: "PAYPAL_CAPTURE_DENIED",
          providerStatusReason: safeReason(capture.status_details?.reason),
          payerActionUrl: null,
        },
      });
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.FAILED },
      });
      if (payment.proposal.reservation?.status === ReservationStatus.ACTIVE) {
        await tx.spendReservation.update({
          where: { id: payment.proposal.reservation.id },
          data: { status: ReservationStatus.RELEASED, releasedAt: providerTime },
        });
      }
      await this.audit(tx, payment, event, AuditEventType.PAYMENT_FAILED, {
        paypalCaptureId: capture.id,
        failureCode: "PAYPAL_CAPTURE_DENIED",
      });
      return "processed";
    }

    if (event.event_type === "PAYMENT.CAPTURE.PENDING" && capture.status === "PENDING") {
      return this.recordPendingCapture(tx, payment, event, capture);
    }

    if (capture.status !== "COMPLETED") return "pending";
    return this.completeCapture(tx, payment, event, capture, order);
  }

  /** Records a held capture and its reason; completion arrives as a later event. */
  private async recordPendingCapture(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    capture: PayPalCapture,
  ): Promise<"processed" | "pending" | "ignored"> {
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) return "processed";
    if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
      return "ignored";
    }
    if (payment.paypalCaptureId && payment.paypalCaptureId !== capture.id) return "ignored";
    const reason = safeReason(capture.status_details?.reason) ?? "PENDING";
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CAPTURE_PENDING,
        paypalCaptureId: capture.id,
        providerStatusReason: reason,
        payerActionUrl: null,
      },
    });
    if (payment.proposal.status !== ProposalStatus.PAYMENT_PENDING) {
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.PAYMENT_PENDING },
      });
    }
    await this.audit(tx, payment, event, AuditEventType.PAYMENT_CAPTURE_REQUESTED, {
      paypalCaptureId: capture.id,
      providerStatus: "PENDING",
      providerStatusReason: reason,
    });
    return "processed";
  }

  private async completeCapture(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    capture: PayPalCapture,
    order: PayPalOrder | null,
  ): Promise<"processed" | "pending" | "ignored"> {
    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      return payment.paypalCaptureId === capture.id ? "processed" : "ignored";
    }
    if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
      return "ignored";
    }
    if (payment.paypalCaptureId && payment.paypalCaptureId !== capture.id) return "ignored";
    const providerTime = providerResourceTimestamp(capture);
    if (!providerTime) return "pending";
    let amount: bigint;
    try {
      amount = BigInt(parseProviderMoney(capture.amount));
    } catch {
      return "ignored";
    }
    if (amount !== payment.amount || payment.currency !== "USD") return "ignored";
    if (capture.custom_id !== undefined && capture.custom_id !== payment.proposalId) {
      return "ignored";
    }
    const reservation = payment.proposal.reservation;
    if (!reservation || reservation.status !== ReservationStatus.ACTIVE) return "pending";

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.COMPLETED,
        paypalCaptureId: capture.id,
        capturedAt: providerTime,
        providerStatusReason: null,
        payerActionUrl: null,
      },
    });
    await tx.purchaseProposal.update({
      where: { id: payment.proposalId },
      data: { status: ProposalStatus.COMPLETED },
    });
    await tx.spendReservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.CONSUMED, consumedAt: providerTime },
    });
    await this.audit(tx, payment, event, AuditEventType.PAYMENT_CAPTURED, {
      paypalOrderId: order?.id ?? payment.paypalOrderId,
      paypalCaptureId: capture.id,
      capturedAt: providerTime.toISOString(),
    });
    return "processed";
  }

  private async reconcileRefund(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    refund: PayPalRefund,
    capture: PayPalCapture | null,
    order: PayPalOrder | null,
  ): Promise<"processed" | "pending" | "ignored"> {
    const eventResourceId = typeof event.resource.id === "string" ? event.resource.id : null;
    if (!eventResourceId || eventResourceId !== refund.id) return "ignored";
    const eventOrderId = relatedOrderId(event.resource);
    const eventCaptureId = relatedCaptureId(event.resource);
    if (eventOrderId && (!order || eventOrderId !== order.id)) return "ignored";
    if (eventCaptureId && (!capture || eventCaptureId !== capture.id)) return "ignored";
    if (order && payment.paypalOrderId !== order.id) return "ignored";
    if (
      !capture ||
      capture.id !== payment.paypalCaptureId ||
      (order !== null && !orderBindingMatches(payment, order)) ||
      !customIdMatches(payment, [
        ...captureCustomIds(capture),
        ...(order ? orderCustomIds(order) : []),
      ])
    ) {
      return "ignored";
    }
    let amount: bigint;
    try {
      amount = BigInt(parseProviderMoney(refund.amount));
    } catch {
      return "ignored";
    }
    if (amount <= 0n || amount > payment.amount || payment.currency !== "USD") return "ignored";
    const providerTime = providerResourceTimestamp(refund);
    if (!providerTime) return "pending";
    if (refund.status === "PENDING") return "pending";
    if (refund.status !== "COMPLETED") return "ignored";

    const refunds = payment.refunds;
    const existing =
      refunds.find((item) => item.paypalRefundId === refund.id) ??
      (refund.invoice_id ? refunds.find((item) => item.id === refund.invoice_id) : undefined);
    if (!existing) {
      return this.recordProviderInitiatedRefund(tx, payment, event, refund, amount, providerTime);
    }
    if (existing.amount !== amount || existing.currency !== "USD") return "ignored";
    if (existing.status === RefundStatus.COMPLETED) return "processed";
    if (
      existing.status !== RefundStatus.REQUESTED &&
      existing.status !== RefundStatus.APPROVED &&
      existing.status !== RefundStatus.SUBMITTED
    ) {
      return "ignored";
    }
    await tx.refund.update({
      where: { id: existing.id },
      data: { paypalRefundId: refund.id, status: RefundStatus.COMPLETED, settledAt: providerTime },
    });
    await this.updateRefundedStatus(tx, payment);
    await this.audit(tx, payment, event, AuditEventType.REFUND_COMPLETED, {
      paypalRefundId: refund.id,
      amountMinor: amount.toString(),
    });
    return "processed";
  }

  /**
   * A completed refund for a known capture that MandatePay did not submit
   * (for example from the PayPal dashboard). The refund was re-fetched from
   * PayPal; it is recorded once and only within the captured amount.
   */
  private async recordProviderInitiatedRefund(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    refund: PayPalRefund,
    amount: bigint,
    settledAt: Date,
  ): Promise<"processed" | "pending" | "ignored"> {
    if (
      payment.status !== PaymentStatus.COMPLETED &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED &&
      payment.status !== PaymentStatus.REFUNDED &&
      payment.status !== PaymentStatus.REVERSED
    ) {
      return "pending";
    }
    const completed = payment.refunds
      .filter((item) => item.status === RefundStatus.COMPLETED)
      .reduce((total, item) => total + item.amount, 0n);
    if (completed + amount > payment.amount) return "ignored";
    await tx.refund.create({
      data: {
        paymentId: payment.id,
        userId: payment.userId,
        paypalRefundId: refund.id,
        amount,
        currency: "USD",
        status: RefundStatus.COMPLETED,
        providerInitiated: true,
        reason: "Refund issued in PayPal outside MandatePay.",
        idempotencyKey: `paypal-provider-refund:${refund.id}`.slice(0, 255),
        settledAt,
      },
    });
    await this.updateRefundedStatus(tx, payment);
    await this.audit(tx, payment, event, AuditEventType.REFUND_COMPLETED, {
      paypalRefundId: refund.id,
      amountMinor: amount.toString(),
      providerInitiated: "true",
    });
    return "processed";
  }

  private async updateRefundedStatus(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
  ) {
    if (payment.status === PaymentStatus.REVERSED) return;
    const aggregate = await tx.refund.aggregate({
      where: { paymentId: payment.id, isSample: false, status: RefundStatus.COMPLETED },
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
  }

  /** A chargeback/reversal of a captured payment, verified against PayPal's capture. */
  private async reconcileReversal(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    capture: PayPalCapture,
    reversal: PayPalRefund | null,
    order: PayPalOrder | null,
  ): Promise<"processed" | "pending" | "ignored"> {
    const eventResourceId = typeof event.resource.id === "string" ? event.resource.id : null;
    if (!eventResourceId || eventResourceId !== (reversal?.id ?? capture.id)) return "ignored";
    if (capture.id !== payment.paypalCaptureId) return "ignored";
    if (order && (payment.paypalOrderId !== order.id || !orderBindingMatches(payment, order))) {
      return "ignored";
    }
    if (
      !customIdMatches(payment, [
        ...captureCustomIds(capture),
        ...(order ? orderCustomIds(order) : []),
      ])
    ) {
      return "ignored";
    }
    let captureAmount: bigint;
    let reversedAmount: bigint;
    try {
      captureAmount = BigInt(parseProviderMoney(capture.amount));
      reversedAmount = reversal ? BigInt(parseProviderMoney(reversal.amount)) : captureAmount;
    } catch {
      return "ignored";
    }
    if (captureAmount !== payment.amount || payment.currency !== "USD") return "ignored";
    if (reversedAmount <= 0n || reversedAmount > payment.amount) return "ignored";
    if (payment.status === PaymentStatus.REVERSED) return "processed";
    if (!SETTLED_PAYMENT_STATUSES.includes(payment.status)) return "pending";
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.REVERSED, providerStatusReason: "CAPTURE_REVERSED" },
    });
    await this.audit(tx, payment, event, AuditEventType.PAYMENT_REVERSED, {
      paypalCaptureId: capture.id,
      paypalReversalId: reversal?.id ?? null,
      amountMinor: reversedAmount.toString(),
      previousStatus: payment.status,
    });
    return "processed";
  }

  private async audit(
    tx: TransactionClient,
    payment: NonNullable<PaymentWithBindings>,
    event: PayPalWebhookEvent,
    eventType: AuditEventType,
    payload: Record<string, string | null>,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        userId: payment.userId,
        eventType,
        entityType: AuditEntityType.PAYMENT,
        entityId: payment.id,
        dedupeKey: `paypal:webhook:${event.id}:${eventType}`,
        payload: { providerEventId: event.id, eventType: event.event_type, ...payload },
      },
    });
  }
}

function singleOrderCapture(order: PayPalOrder): PayPalCapture | null {
  const units = order.purchase_units ?? [];
  if (units.length !== 1) return null;
  const captures = units[0]?.payments?.captures ?? [];
  if (captures.length !== 1) return null;
  const parsed = PayPalCaptureSchema.safeParse(captures[0]);
  return parsed.success ? parsed.data : null;
}

export function createPayPalWebhookService(
  database: DatabaseClient,
  paypal: PayPalClient,
  options: { readonly vaultCipher?: VaultCipher | null } = {},
): PayPalWebhookService {
  // Vault events are matched by a keyed hash; without a valid key they are ignored.
  const vault =
    options.vaultCipher === undefined
      ? createVaultCipher(process.env.TOKEN_ENCRYPTION_KEY)
      : options.vaultCipher;
  return new PayPalWebhookService(
    paypal,
    new PrismaWebhookInboxStore(database),
    new PrismaWebhookReconcilerImpl(database, vault),
  );
}
