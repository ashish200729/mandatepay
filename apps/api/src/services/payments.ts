import { randomUUID } from "node:crypto";
import { assertCustomerCapture, assertNewCheckout } from "./platform-controls.js";
import { z } from "zod";
import {
  AuditEntityType,
  AuditEventType,
  DatabaseError,
  PaymentStatus,
  ProposalStatus,
  ReservationStatus,
  assertCurrency,
  assertMinorUnits,
  type DatabaseClient,
  type Prisma,
} from "@mandatepay/database";
import {
  PayPalClient,
  PayPalConfigurationError,
  PayPalCaptureSchema,
  PayPalError,
  parseProviderMoney,
  parsePayPalConfig,
  type CreateOrderInput,
  type PayPalCapture,
  type PayPalOrder,
} from "@mandatepay/paypal";
import { toMinorUnits } from "@mandatepay/shared";
import { revalidateAuthorizationInTransaction, type TransactionClient } from "./proposals.js";

type Owner = { id: string };

export const paymentReceiptInclude = {
  proposal: { include: { productSnapshot: true, mandateVersion: true, approval: true } },
  refunds: { where: { isSample: false }, orderBy: { createdAt: "asc" as const } },
} as const;

export type PaymentReceipt = Prisma.PaymentGetPayload<{ include: typeof paymentReceiptInclude }>;

const receiptInclude = paymentReceiptInclude;

const inFlightOrderRequests = new Map<string, Promise<PayPalOrder>>();
const inFlightCaptureRequests = new Map<string, Promise<PayPalCapture>>();
const settledPaymentStatuses: readonly PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

export interface PayPalGateway {
  createOrder(input: CreateOrderInput): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalCapture>;
  getCapture?(captureId: string): Promise<PayPalCapture>;
}

export interface DemoProductFacts {
  readonly externalId: string;
  readonly priceMinor: number;
  readonly currency: "USD";
  readonly brand: string | null;
  readonly condition: "NEW" | "USED" | "REFURBISHED";
  readonly merchant: string;
  readonly checkoutEligible: boolean;
  readonly demoSku: string | null;
}

export interface PaymentServiceContext {
  readonly database: DatabaseClient;
  readonly paypal: PayPalGateway | null;
  readonly appUrl: string;
  readonly lookupDemoProduct: (externalId: string) => Promise<DemoProductFacts | null>;
}

export class PaymentServiceError extends Error {
  constructor(
    readonly code:
      | "PAYPAL_UNAVAILABLE"
      | "PAYPAL_RESPONSE_INVALID"
      | "PAYPAL_OUTCOME_UNKNOWN"
      | "PAYER_APPROVAL_REQUIRED",
    readonly httpStatus = 503,
  ) {
    super("The PayPal payment service could not complete this request.");
    this.name = "PaymentServiceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PaymentDTO {
  readonly id: string;
  readonly proposalId: string;
  readonly status: PaymentStatus;
  readonly amount: number;
  readonly currency: "USD";
  readonly paypalOrderId: string | null;
  readonly paypalCaptureId: string | null;
  readonly capturedAt: string | null;
  readonly createdAt: string;
  readonly authorizationExpiresAt: string | null;
  readonly product: {
    readonly title: string;
    readonly brand: string;
    readonly condition: "NEW" | "USED" | "REFURBISHED";
    readonly merchant: string;
    readonly source: string;
  };
  readonly mandate: { readonly title: string; readonly version: number };
  readonly refunds: readonly {
    readonly id: string;
    readonly status: string;
    readonly amount: number;
    readonly currency: "USD";
    readonly paypalRefundId: string | null;
  }[];
}

function safeAmount(value: bigint, field: string): number {
  assertMinorUnits(value, field);
  return Number(value);
}

function paymentDTO(payment: PaymentReceipt): PaymentDTO {
  const snapshot = payment.proposal.productSnapshot;
  if (
    snapshot.condition !== "NEW" &&
    snapshot.condition !== "USED" &&
    snapshot.condition !== "REFURBISHED"
  ) {
    throw new DatabaseError("INVALID_STATE", "The product condition is not purchasable.");
  }
  assertCurrency(payment.currency);
  if (payment.currency !== "USD") {
    throw new DatabaseError("INVALID_CURRENCY", "Only USD payments are supported.");
  }
  return {
    id: payment.id,
    proposalId: payment.proposalId,
    status: payment.status,
    amount: safeAmount(payment.amount, "payment amount"),
    currency: "USD",
    paypalOrderId: payment.paypalOrderId,
    paypalCaptureId: payment.paypalCaptureId,
    capturedAt: payment.capturedAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    authorizationExpiresAt: new Date(
      Math.min(
        ...[
          payment.proposal.expiresAt,
          payment.proposal.approval?.expiresAt,
          payment.proposal.mandateVersion.expiresAt,
        ]
          .filter((date): date is Date => date instanceof Date)
          .map((date) => date.getTime()),
      ),
    ).toISOString(),
    product: {
      title: snapshot.title,
      brand: snapshot.brand ?? "Unknown",
      condition: snapshot.condition,
      merchant: snapshot.merchant,
      source: snapshot.source,
    },
    mandate: {
      title: payment.proposal.mandateVersion.title,
      version: payment.proposal.mandateVersion.version,
    },
    refunds: payment.refunds.map((refund) => ({
      id: refund.id,
      status: refund.status,
      amount: safeAmount(refund.amount, "refund amount"),
      currency: "USD",
      paypalRefundId: refund.paypalRefundId,
    })),
  };
}

export async function receiptForUser(
  database: DatabaseClient,
  userId: string,
  paymentId: string,
): Promise<PaymentReceipt> {
  const payment = await database.payment.findFirst({
    where: {
      userId,
      isSample: false,
      proposal: { isSample: false },
      OR: [{ id: paymentId }, { paypalOrderId: paymentId }],
    },
    include: receiptInclude,
  });
  if (!payment) throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
  return payment;
}

async function proposalForUser(database: DatabaseClient, userId: string, proposalId: string) {
  const proposal = await database.purchaseProposal.findFirst({
    where: { id: proposalId, userId, isSample: false },
    include: { productSnapshot: true, payment: true },
  });
  if (!proposal) throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found.");
  if (proposal.payment?.isSample)
    throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found.");
  return proposal;
}

function metadataExternalId(metadata: Prisma.JsonValue): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).externalId;
  return typeof value === "string" && value.trim() ? value : null;
}

function metadataDemoSku(metadata: Prisma.JsonValue): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).demoSku;
  return typeof value === "string" && value.trim() ? value : null;
}

async function authoritativeDemoProduct(
  context: PaymentServiceContext,
  product: {
    source: string;
    externalId: string;
    price: bigint;
    currency: string;
    brand: string | null;
    condition: string;
    merchant: string;
    metadata: Prisma.JsonValue;
  },
) {
  if (product.source !== "demo") {
    throw new DatabaseError(
      "INVALID_STATE",
      "External discovery products are not eligible for demo checkout.",
    );
  }
  const externalId = metadataExternalId(product.metadata);
  const demoSku = metadataDemoSku(product.metadata);
  if (!externalId || !demoSku) {
    throw new DatabaseError("CONFLICT", "The product snapshot identity is stale.");
  }
  const fresh = await context.lookupDemoProduct(externalId);
  if (
    !fresh ||
    !fresh.checkoutEligible ||
    !fresh.demoSku ||
    fresh.externalId !== externalId ||
    fresh.demoSku !== demoSku ||
    fresh.currency !== "USD" ||
    !Number.isSafeInteger(fresh.priceMinor) ||
    fresh.priceMinor < 0 ||
    BigInt(fresh.priceMinor) !== product.price ||
    fresh.brand !== product.brand ||
    fresh.condition !== product.condition ||
    fresh.merchant !== product.merchant
  ) {
    throw new DatabaseError("CONFLICT", "The current demo product no longer matches the proposal.");
  }
  return { price: BigInt(fresh.priceMinor), currency: fresh.currency as "USD" };
}

function expectedRedirect(appUrl: string, paymentId: string, result: "return" | "cancel") {
  try {
    const url = new URL(`/orders/${encodeURIComponent(paymentId)}?paypal=${result}`, appUrl);
    return url.toString();
  } catch {
    throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  }
}

function safeApprovalUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.hostname !== "sandbox.paypal.com" && parsed.hostname !== "www.sandbox.paypal.com")
    ) {
      throw new Error("invalid approval URL");
    }
    return value;
  } catch {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
}

function validateProviderOrder(
  order: PayPalOrder,
  payment: PaymentReceipt,
  expectedOrderId?: string | null,
) {
  if (
    !order.id ||
    (expectedOrderId !== undefined && order.id !== expectedOrderId) ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  ) {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
  const unit = order.purchase_units[0];
  if (!unit) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  if (
    unit.reference_id !== payment.id ||
    unit.custom_id !== payment.proposalId ||
    !unit.amount ||
    unit.amount.currency_code !== "USD" ||
    parseProviderMoney(unit.amount) !== Number(payment.amount)
  ) {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
}

function validateProviderCapture(capture: PayPalCapture, payment: PaymentReceipt) {
  validateProviderCaptureFacts(capture, payment);
  if (capture.status !== "COMPLETED") {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
}

function validateProviderCaptureFacts(capture: PayPalCapture, payment: PaymentReceipt) {
  if (
    capture.amount.currency_code !== "USD" ||
    parseProviderMoney(capture.amount) !== Number(payment.amount) ||
    (capture.custom_id !== undefined && capture.custom_id !== payment.proposalId)
  ) {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
}

function providerCaptureTimestamp(capture: PayPalCapture): Date {
  const timestamp = z.iso.datetime({ offset: true }).safeParse(capture.create_time);
  if (!timestamp.success) {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
  const parsed = new Date(timestamp.data);
  if (Number.isNaN(parsed.getTime())) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  return parsed;
}

function completedCaptureFromOrder(
  order: PayPalOrder,
  payment: PaymentReceipt,
): PayPalCapture | null {
  const units = order.purchase_units ?? [];
  if (units.length !== 1) return null;
  const captures = units[0]?.payments?.captures ?? [];
  if (captures.length !== 1) return null;
  const parsed = PayPalCaptureSchema.safeParse(captures[0]);
  if (!parsed.success) return null;
  const capture = parsed.data;
  try {
    validateProviderCapture(capture, payment);
    return capture;
  } catch {
    return null;
  }
}

function asPendingReceipt(error: unknown): error is PayPalError | PaymentServiceError {
  return (
    error instanceof PayPalError ||
    (error instanceof PaymentServiceError &&
      (error.code === "PAYPAL_RESPONSE_INVALID" || error.code === "PAYPAL_OUTCOME_UNKNOWN"))
  );
}

async function currentReceipt(
  context: PaymentServiceContext,
  paymentId: string,
  userId: string,
): Promise<PaymentReceipt> {
  return receiptForUser(context.database, userId, paymentId);
}

async function lockPaymentInOrder(
  tx: TransactionClient,
  userId: string,
  paymentId: string,
): Promise<PaymentReceipt> {
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
  const unlocked = await tx.payment.findFirst({
    where: { id: paymentId, userId, isSample: false, proposal: { isSample: false } },
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
    include: receiptInclude,
  });
  if (!payment) throw new DatabaseError("NOT_FOUND", "Payment was not found for this user.");
  return payment;
}

async function finalizeOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  order: PayPalOrder,
) {
  return context.database.$transaction(async (tx) => {
    const payment = await lockPaymentInOrder(tx, user.id, paymentId);
    if (payment.paypalOrderId && payment.paypalOrderId !== order.id) {
      throw new DatabaseError("CONFLICT", "Payment is already bound to another PayPal order.");
    }
    if (payment.paypalOrderId === order.id) return payment;
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { paypalOrderId: order.id },
      include: receiptInclude,
    });
    if (payment.proposal.status === ProposalStatus.AUTHORIZED) {
      await tx.purchaseProposal.update({
        where: { id: payment.proposalId },
        data: { status: ProposalStatus.PAYPAL_ORDER_CREATED },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
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
        },
      },
    });
    return updated;
  });
}

export async function createPaypalOrder(
  context: PaymentServiceContext,
  user: Owner,
  proposalId: string,
) {
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  const proposal = await proposalForUser(context.database, user.id, proposalId);
  if (
    proposal.payment &&
    (settledPaymentStatuses.includes(proposal.payment.status) ||
      proposal.payment.status === PaymentStatus.DENIED ||
      proposal.payment.status === PaymentStatus.FAILED)
  ) {
    return {
      payment: paymentDTO(await receiptForUser(context.database, user.id, proposal.payment.id)),
      approvalUrl: null,
      pending: false,
    };
  }
  if (!proposal.payment?.paypalOrderId) await assertNewCheckout(context.database);
  const authoritative = await authoritativeDemoProduct(context, proposal.productSnapshot);

  const claimed = await context.database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const existing = await tx.payment.findFirst({
      where: { proposalId, userId: user.id, isSample: false },
      include: receiptInclude,
    });
    if (existing) {
      if (
        !existing.paypalOrderId &&
        existing.status !== PaymentStatus.FAILED &&
        existing.status !== PaymentStatus.DENIED
      ) {
        const authorization = await revalidateAuthorizationInTransaction(
          tx,
          user,
          proposalId,
          authoritative,
        );
        if (!authorization.authorized) return { authorization } as const;
      }
      return { existing } as const;
    }

    const authorization = await revalidateAuthorizationInTransaction(
      tx,
      user,
      proposalId,
      authoritative,
    );
    if (!authorization.authorized) return { authorization } as const;
    const payment = await tx.payment.create({
      data: {
        userId: user.id,
        mandateId: authorization.proposal.mandateId,
        proposalId: authorization.proposal.id,
        amount: authorization.proposal.total,
        currency: authorization.proposal.currency,
        status: PaymentStatus.CREATED,
        idempotencyKey: `paypal-payment:${authorization.proposal.id}`,
        paypalOrderRequestId: randomUUID(),
        paypalCaptureRequestId: randomUUID(),
      },
      include: receiptInclude,
    });
    return { payment } as const;
  });

  if ("authorization" in claimed) {
    throw new PaymentServiceError("PAYER_APPROVAL_REQUIRED", 409);
  }
  if ("existing" in claimed && claimed.existing) {
    const payment = claimed.existing;
    if (
      settledPaymentStatuses.includes(payment.status) ||
      payment.status === PaymentStatus.FAILED ||
      payment.status === PaymentStatus.DENIED
    ) {
      return { payment: paymentDTO(payment), approvalUrl: null, pending: false };
    }
    if (!payment.paypalOrderId) {
      return createProviderOrder(context, user, payment);
    }
    let approvalUrl: string | null = null;
    let pending = false;
    try {
      const order = await context.paypal.getOrder(payment.paypalOrderId);
      validateProviderOrder(order, payment, payment.paypalOrderId);
      approvalUrl = safeApprovalUrl(order.approvalUrl);
      if (!approvalUrl) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
    } catch (error) {
      if (!asPendingReceipt(error)) throw error;
      pending = true;
    }
    return { payment: paymentDTO(payment), approvalUrl, pending };
  }
  return createProviderOrder(context, user, claimed.payment);
}

async function createProviderOrder(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
) {
  if (!context.paypal || !payment.paypalOrderRequestId) {
    throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  }
  await assertNewCheckout(context.database);
  const input: CreateOrderInput = {
    amountMinor: toMinorUnits(safeAmount(payment.amount, "payment amount")),
    referenceId: payment.id,
    customId: payment.proposalId,
    requestId: payment.paypalOrderRequestId,
    returnUrl: expectedRedirect(context.appUrl, payment.id, "return"),
    cancelUrl: expectedRedirect(context.appUrl, payment.id, "cancel"),
  };
  try {
    let providerRequest = inFlightOrderRequests.get(input.requestId);
    if (!providerRequest) {
      providerRequest = context.paypal.createOrder(input);
      inFlightOrderRequests.set(input.requestId, providerRequest);
    }
    let order = await providerRequest;
    const createdOrderId = order.id;
    if (!order.purchase_units || order.purchase_units.length !== 1) {
      // PayPal can still return a minimal create response despite Prefer:
      // return=representation. Hydrate it before any local binding.
      order = await context.paypal.getOrder(order.id);
    }
    validateProviderOrder(order, payment, createdOrderId);
    const approvalUrl = safeApprovalUrl(order.approvalUrl);
    if (!approvalUrl) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
    const persisted = await finalizeOrder(context, user, payment.id, order);
    return { payment: paymentDTO(persisted), approvalUrl, pending: false };
  } catch (error) {
    if (!asPendingReceipt(error)) throw error;
    const current = await currentReceipt(context, payment.id, user.id);
    return { payment: paymentDTO(current), approvalUrl: null, pending: true };
  } finally {
    inFlightOrderRequests.delete(input.requestId);
  }
}

async function markCapturePending(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  authoritative: { price: bigint; currency: "USD" },
) {
  return context.database.$transaction(async (tx) => {
    // This helper locks User -> Mandate -> Proposal -> Payment. Revalidation
    // below takes the already-held parent locks in that same order, so a
    // concurrent capture can return an already-completed receipt idempotently.
    const current = await lockPaymentInOrder(tx, user.id, payment.id);
    if (settledPaymentStatuses.includes(current.status)) {
      return { completed: current as PaymentReceipt } as const;
    }
    if (!current.paypalOrderId || current.paypalOrderId !== payment.paypalOrderId) {
      throw new DatabaseError("CONFLICT", "Payment is bound to a different PayPal order.");
    }
    const authorization = await revalidateAuthorizationInTransaction(
      tx,
      user,
      current.proposalId,
      authoritative,
      {
        allowedProposalStatuses: [
          ProposalStatus.AUTHORIZED,
          ProposalStatus.PAYPAL_ORDER_CREATED,
          ProposalStatus.PAYMENT_PENDING,
        ],
      },
    );
    if (!authorization.authorized) return { authorization } as const;
    if (current.status === PaymentStatus.CAPTURE_PENDING) {
      return { pending: current as PaymentReceipt } as const;
    }
    if (current.status !== PaymentStatus.CREATED && current.status !== PaymentStatus.APPROVED) {
      throw new DatabaseError("INVALID_STATE", "Payment is not ready to be captured.");
    }
    if (current.status === PaymentStatus.CREATED) {
      await tx.payment.update({
        where: { id: current.id },
        data: { status: PaymentStatus.APPROVED },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: AuditEventType.PAYPAL_ORDER_APPROVED,
          entityType: AuditEntityType.PAYMENT,
          entityId: current.id,
          dedupeKey: `paypal-order-approved:${current.id}`,
          payload: { paymentId: current.id, proposalId: current.proposalId },
        },
      });
    }
    const pending = await tx.payment.update({
      where: { id: current.id },
      data: { status: PaymentStatus.CAPTURE_PENDING },
      include: receiptInclude,
    });
    await tx.purchaseProposal.update({
      where: { id: current.proposalId },
      data: { status: ProposalStatus.PAYMENT_PENDING },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_CAPTURE_REQUESTED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-capture-requested:${current.id}`,
        payload: { paymentId: current.id, proposalId: current.proposalId },
      },
    });
    return { pending } as const;
  });
}

async function finalizeCapture(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  capture: PayPalCapture,
  capturedAt: Date,
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (settledPaymentStatuses.includes(current.status)) {
      if (current.paypalCaptureId === capture.id) return current;
      throw new DatabaseError("CONFLICT", "Payment is already completed with another capture.");
    }
    if (current.status !== PaymentStatus.CAPTURE_PENDING) {
      throw new DatabaseError("INVALID_STATE", "Payment is not awaiting capture completion.");
    }
    const reservation = await tx.spendReservation.findUnique({
      where: { proposalId: current.proposalId },
    });
    if (!reservation) {
      throw new DatabaseError("INVALID_STATE", "The payment reservation is missing.");
    }
    if (
      reservation.status !== ReservationStatus.ACTIVE &&
      reservation.status !== ReservationStatus.CONSUMED
    ) {
      throw new DatabaseError("INVALID_STATE", "The payment reservation is no longer active.");
    }
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: {
        paypalCaptureId: capture.id,
        status: PaymentStatus.COMPLETED,
        capturedAt,
      },
      include: receiptInclude,
    });
    await tx.purchaseProposal.update({
      where: { id: current.proposalId },
      data: { status: ProposalStatus.COMPLETED },
    });
    if (reservation.status === ReservationStatus.ACTIVE) {
      await tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.CONSUMED, consumedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: AuditEventType.SPEND_RESERVATION_CONSUMED,
          entityType: AuditEntityType.SPEND_RESERVATION,
          entityId: reservation.id,
          dedupeKey: `paypal-reservation-consumed:${reservation.id}`,
          payload: { paymentId: current.id, proposalId: current.proposalId },
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_CAPTURED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-payment-captured:${current.id}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          paypalCaptureId: capture.id,
          amount: Number(current.amount),
          currency: current.currency,
        },
      },
    });
    return updated;
  });
}

async function finalizeDeclinedCapture(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  capture: PayPalCapture,
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (settledPaymentStatuses.includes(current.status)) return current;
    if (current.status === PaymentStatus.DENIED || current.status === PaymentStatus.FAILED) {
      return current;
    }
    if (current.status !== PaymentStatus.CAPTURE_PENDING) {
      throw new DatabaseError("INVALID_STATE", "Payment is not awaiting a capture outcome.");
    }
    const reservation = await tx.spendReservation.findUnique({
      where: { proposalId: current.proposalId },
    });
    if (!reservation || reservation.status !== ReservationStatus.ACTIVE) {
      throw new DatabaseError("INVALID_STATE", "The payment reservation is not releasable.");
    }
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: { status: PaymentStatus.DENIED, failureCode: "PAYPAL_CAPTURE_DECLINED" },
      include: receiptInclude,
    });
    await tx.purchaseProposal.update({
      where: { id: current.proposalId },
      data: { status: ProposalStatus.FAILED },
    });
    await tx.spendReservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_FAILED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-payment-declined:${current.id}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          providerCaptureId: capture.id,
          reason: "PAYPAL_CAPTURE_DECLINED",
        },
      },
    });
    return updated;
  });
}

export async function capturePaypalOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentOrOrderId: string,
) {
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  let payment = await receiptForUser(context.database, user.id, paymentOrOrderId);
  if (settledPaymentStatuses.includes(payment.status)) {
    return { payment: paymentDTO(payment), pending: false };
  }
  if (payment.status === PaymentStatus.DENIED || payment.status === PaymentStatus.FAILED) {
    return { payment: paymentDTO(payment), pending: false };
  }
  if (!payment.paypalOrderId || !payment.paypalCaptureRequestId) {
    throw new DatabaseError("INVALID_STATE", "A PayPal order must be created before capture.");
  }
  await assertCustomerCapture(context.database);
  let order: PayPalOrder;
  try {
    order = await context.paypal.getOrder(payment.paypalOrderId);
    validateProviderOrder(order, payment, payment.paypalOrderId);
  } catch (error) {
    if (!asPendingReceipt(error)) throw error;
    payment = await currentReceipt(context, payment.id, user.id);
    return { payment: paymentDTO(payment), pending: true };
  }
  if (order.status === "COMPLETED" && payment.status === PaymentStatus.CAPTURE_PENDING) {
    const completedCapture = completedCaptureFromOrder(order, payment);
    if (completedCapture) {
      const completed = await finalizeCapture(
        context,
        user,
        payment.id,
        completedCapture,
        providerCaptureTimestamp(completedCapture),
      );
      return { payment: paymentDTO(completed), pending: false };
    }
    const current = await currentReceipt(context, payment.id, user.id);
    return { payment: paymentDTO(current), pending: true };
  }
  if (order.status !== "APPROVED") {
    throw new PaymentServiceError("PAYER_APPROVAL_REQUIRED", 409);
  }

  const proposal = await proposalForUser(context.database, user.id, payment.proposalId);
  const authoritative = await authoritativeDemoProduct(context, proposal.productSnapshot);

  const claimed = await markCapturePending(context, user, payment, authoritative);
  if ("authorization" in claimed) {
    throw new PaymentServiceError("PAYER_APPROVAL_REQUIRED", 409);
  }
  if ("completed" in claimed && claimed.completed) {
    return { payment: paymentDTO(claimed.completed), pending: false };
  }
  if (!("pending" in claimed)) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  const pending = claimed.pending;
  if (!pending.paypalCaptureRequestId) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  try {
    let providerRequest = inFlightCaptureRequests.get(pending.paypalCaptureRequestId);
    if (!providerRequest) {
      providerRequest = context.paypal.captureOrder(order.id, pending.paypalCaptureRequestId);
      inFlightCaptureRequests.set(pending.paypalCaptureRequestId, providerRequest);
    }
    const capture = await providerRequest;
    if (capture.status === "DECLINED") {
      validateProviderCaptureFacts(capture, pending);
      const denied = await finalizeDeclinedCapture(context, user, pending.id, capture);
      return { payment: paymentDTO(denied), pending: false };
    }
    validateProviderCapture(capture, pending);
    const completed = await finalizeCapture(
      context,
      user,
      pending.id,
      capture,
      providerCaptureTimestamp(capture),
    );
    return { payment: paymentDTO(completed), pending: false };
  } catch (error) {
    if (!asPendingReceipt(error)) throw error;
    const current = await currentReceipt(context, pending.id, user.id);
    return { payment: paymentDTO(current), pending: true };
  } finally {
    inFlightCaptureRequests.delete(pending.paypalCaptureRequestId);
  }
}

export async function listPayments(context: PaymentServiceContext, user: Owner) {
  const payments = await context.database.payment.findMany({
    where: { userId: user.id, isSample: false, proposal: { isSample: false } },
    include: receiptInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { orders: payments.map(paymentDTO) };
}

/** Checks existing provider records only; never creates or captures an order. */
export async function reconcilePaypalOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
) {
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  const payment = await receiptForUser(context.database, user.id, paymentId);
  if (
    settledPaymentStatuses.includes(payment.status) ||
    payment.status === PaymentStatus.DENIED ||
    payment.status === PaymentStatus.FAILED
  ) {
    return { payment: paymentDTO(payment), pending: false };
  }
  if (!payment.paypalOrderId) return { payment: paymentDTO(payment), pending: true };
  try {
    const order = await context.paypal.getOrder(payment.paypalOrderId);
    validateProviderOrder(order, payment, payment.paypalOrderId);
    if (order.status === "COMPLETED" && payment.status === PaymentStatus.CAPTURE_PENDING) {
      let capture = completedCaptureFromOrder(order, payment);
      if (capture && !capture.create_time && context.paypal.getCapture) {
        const hydrated = await context.paypal.getCapture(capture.id);
        if (hydrated.id !== capture.id) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
        validateProviderCapture(hydrated, payment);
        capture = hydrated;
      }
      if (capture) {
        const completed = await finalizeCapture(
          context,
          user,
          payment.id,
          capture,
          providerCaptureTimestamp(capture),
        );
        return { payment: paymentDTO(completed), pending: false };
      }
    }
    if (order.status === "APPROVED" && payment.status === PaymentStatus.CREATED) {
      const approved = await context.database.$transaction(async (tx) => {
        const current = await lockPaymentInOrder(tx, user.id, payment.id);
        if (current.status !== PaymentStatus.CREATED) return current;
        validateProviderOrder(order, current, current.paypalOrderId);
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: AuditEventType.PAYPAL_ORDER_APPROVED,
            entityType: AuditEntityType.PAYMENT,
            entityId: current.id,
            dedupeKey: `paypal-order-approved:${current.id}`,
            payload: { paymentId: current.id, proposalId: current.proposalId },
          },
        });
        return tx.payment.update({
          where: { id: current.id },
          data: { status: PaymentStatus.APPROVED },
          include: receiptInclude,
        });
      });
      return {
        payment: paymentDTO(approved),
        pending: approved.status === PaymentStatus.CAPTURE_PENDING,
      };
    }
  } catch (error) {
    if (!asPendingReceipt(error)) throw error;
  }
  const current = await currentReceipt(context, payment.id, user.id);
  return {
    payment: paymentDTO(current),
    pending: !settledPaymentStatuses.includes(current.status),
  };
}

export async function getPayment(
  context: PaymentServiceContext,
  user: Owner,
  paymentOrOrderId: string,
) {
  return { payment: paymentDTO(await receiptForUser(context.database, user.id, paymentOrOrderId)) };
}

export function createPayPalClientFromEnvironment(input: {
  PAYPAL_ENV?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
}) {
  try {
    return new PayPalClient(
      parsePayPalConfig({
        environment: input.PAYPAL_ENV,
        clientId: input.PAYPAL_CLIENT_ID,
        clientSecret: input.PAYPAL_CLIENT_SECRET,
        webhookId: input.PAYPAL_WEBHOOK_ID?.trim() || null,
      }),
    );
  } catch (error) {
    if (error instanceof PayPalConfigurationError) return null;
    throw error;
  }
}

export function payPalStatusFromEnvironment(input: {
  PAYPAL_ENV?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
}) {
  return {
    configured:
      input.PAYPAL_ENV === "sandbox" &&
      Boolean(input.PAYPAL_CLIENT_ID?.trim()) &&
      Boolean(input.PAYPAL_CLIENT_SECRET?.trim()),
    environment: "sandbox" as const,
    webhookConfigured: Boolean(input.PAYPAL_WEBHOOK_ID?.trim()),
  };
}

export { paymentDTO as serializePayment };
