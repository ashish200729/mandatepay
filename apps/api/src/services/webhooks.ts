import type { Prisma } from "@mandatepay/database";
import {
  AuditEntityType,
  AuditEventType,
  PaymentStatus,
  ProposalStatus,
  RefundStatus,
  ReservationStatus,
  type DatabaseClient,
  type Prisma as PrismaNamespace,
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
  parseProviderMoney,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalRefund,
} from "@mandatepay/paypal";
import type { PayPalWebhookEvent } from "@mandatepay/paypal";

const PROCESSING_LEASE_MS = 5 * 60_000;

function jsonPayload(event: PayPalWebhookEvent): Prisma.InputJsonValue {
  return event as unknown as Prisma.InputJsonValue;
}

class PrismaWebhookInboxStore implements WebhookInboxStore {
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
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
  }

  async markPending(id: string, reason: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: { status: "FAILED", lastError: reason.slice(0, 10_000) },
    });
  }

  async markIgnored(id: string, reason: string): Promise<void> {
    await this.db.webhookInbox.update({
      where: { id },
      data: { status: "IGNORED", lastError: reason.slice(0, 10_000) },
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

class PrismaWebhookReconcilerImpl implements PayPalWebhookReconciler {
  constructor(private readonly db: DatabaseClient) {}

  async findPayment(authoritative: AuthoritativeWebhookData) {
    const orderId =
      authoritative.kind === "order" ? authoritative.order.id : (authoritative.order?.id ?? null);
    const captureId =
      authoritative.kind === "capture" || authoritative.kind === "refund"
        ? (authoritative.capture?.id ?? null)
        : null;
    const payments = await this.db.payment.findMany({
      where: {
        OR: [
          ...(orderId ? [{ paypalOrderId: orderId }] : []),
          ...(captureId ? [{ paypalCaptureId: captureId }] : []),
        ],
      },
      include: {
        proposal: { include: { productSnapshot: true, reservation: true } },
        refunds: true,
      },
    });
    return payments.length === 1 ? payments[0] : null;
  }

  async reconcile(input: {
    event: PayPalWebhookEvent;
    authoritative: AuthoritativeWebhookData;
  }): Promise<"processed" | "pending" | "ignored"> {
    const candidate = await this.findPayment(input.authoritative);
    if (!candidate) return "ignored";

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Mandate" WHERE id = ${candidate.mandateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PurchaseProposal" WHERE id = ${candidate.proposalId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${candidate.id} FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: candidate.id },
        include: {
          proposal: { include: { productSnapshot: true, reservation: true } },
          refunds: true,
        },
      });
      if (!payment) return "ignored";

      if (input.authoritative.kind === "order") {
        return this.reconcileOrder(tx, payment, input.event, input.authoritative.order);
      }
      if (input.authoritative.kind === "capture") {
        return this.reconcileCapture(
          tx,
          payment,
          input.event,
          input.authoritative.capture,
          input.authoritative.order,
        );
      }
      return this.reconcileRefund(
        tx,
        payment,
        input.event,
        input.authoritative.refund,
        input.authoritative.capture,
        input.authoritative.order,
      );
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
    if (
      payment.status === PaymentStatus.COMPLETED ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      return "processed";
    }
    if (payment.status !== PaymentStatus.CREATED && payment.status !== PaymentStatus.APPROVED) {
      return "pending";
    }
    if (payment.status === PaymentStatus.CREATED) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.APPROVED },
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
      if (capture.status !== "DECLINED") return "pending";
      if (
        payment.status === PaymentStatus.COMPLETED ||
        payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED
      ) {
        return "ignored";
      }
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
        data: { status: PaymentStatus.DENIED, failureCode: "PAYPAL_CAPTURE_DENIED" },
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

    if (capture.status !== "COMPLETED") return "pending";
    if (
      payment.status === PaymentStatus.COMPLETED ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      return payment.paypalCaptureId === capture.id ? "processed" : "ignored";
    }
    if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
      return "ignored";
    }
    if (
      payment.status !== PaymentStatus.APPROVED &&
      payment.status !== PaymentStatus.CAPTURE_PENDING
    ) {
      return "pending";
    }
    const reservation = payment.proposal.reservation;
    if (!reservation || reservation.status !== ReservationStatus.ACTIVE) return "pending";

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.COMPLETED,
        paypalCaptureId: capture.id,
        capturedAt: providerTime,
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
    if (!existing) return "ignored";
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
    await this.audit(tx, payment, event, AuditEventType.REFUND_COMPLETED, {
      paypalRefundId: refund.id,
      amountMinor: amount.toString(),
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

export function createPayPalWebhookService(
  database: DatabaseClient,
  paypal: PayPalClient,
): PayPalWebhookService {
  return new PayPalWebhookService(
    paypal,
    new PrismaWebhookInboxStore(database),
    new PrismaWebhookReconcilerImpl(database),
  );
}
