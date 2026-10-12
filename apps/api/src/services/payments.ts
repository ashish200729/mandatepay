import { randomUUID } from "node:crypto";
import {
  assertCustomerCapture,
  assertNewCheckout,
  readPlatformControlsFailClosed,
} from "./platform-controls.js";
import { z } from "zod";
import {
  ApprovalDecision,
  AuditEntityType,
  AuditEventType,
  DatabaseError,
  MandateStatus,
  PaymentProfileStatus,
  PaymentSource,
  PaymentStatus,
  PolicyDecisionType,
  ProposalStatus,
  ReservationStatus,
  assertCurrency,
  assertMinorUnits,
  type DatabaseClient,
  type Prisma,
} from "@mandatepay/database";
import {
  PAYPAL_ENVIRONMENTS,
  PayPalClient,
  PayPalConfigurationError,
  PayPalCaptureSchema,
  PayPalError,
  isDefinitivePayPalRejection,
  parseProviderMoney,
  parsePayPalConfig,
  type CreateOrderInput,
  type CreateVaultOrderInput,
  type PayPalCapture,
  type PayPalEnvironmentHosts,
  type PayPalOrder,
  type PayPalProviderError,
} from "@mandatepay/paypal";
import { CanonicalMandateSchema, toMinorUnits } from "@mandatepay/shared";
import { revalidateAuthorizationInTransaction, type TransactionClient } from "./proposals.js";
import { VaultCipherError, type VaultCipher } from "./vault-crypto.js";
import { CartMandateMismatchError, assertCartMandate } from "./mandate-credentials.js";

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
  PaymentStatus.REVERSED,
];
const terminalUnpaidStatuses: readonly PaymentStatus[] = [
  PaymentStatus.DENIED,
  PaymentStatus.FAILED,
];
const unpaidOpenStatuses: readonly PaymentStatus[] = [
  PaymentStatus.CREATED,
  PaymentStatus.APPROVED,
  PaymentStatus.CAPTURE_PENDING,
];

/** PayPal issues after which the buyer can recover by choosing another funding source. */
const PAYER_ACTION_ISSUES = new Set(["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED"]);
const SAFE_REASON_PATTERN = /^[A-Z0-9_]{1,64}$/u;

/**
 * A capture that stays CAPTURE_PENDING while PayPal still shows the order as
 * APPROVED is returned to the payer only after this age, so a capture request
 * that is still in flight is never undone.
 */
export const CAPTURE_PENDING_STALE_MS = 10 * 60_000;

export interface PayPalGateway {
  createOrder(input: CreateOrderInput): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalCapture>;
  getCapture?(captureId: string): Promise<PayPalCapture>;
  /** Builds the documented buyer redirect for an existing order. */
  checkoutUrl?(orderId: string): string;
  /** Environment hosts; Sandbox when absent. */
  readonly hosts?: PayPalEnvironmentHosts;
  /** Buyer-not-present order charged to a saved PayPal Vault payment token. */
  createVaultOrder?(input: CreateVaultOrderInput): Promise<PayPalOrder>;
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
  /** Present only when TOKEN_ENCRYPTION_KEY is a valid 32-byte key; enables Vault autopay. */
  readonly vault?: VaultCipher | null;
}

export class PaymentServiceError extends Error {
  constructor(
    readonly code:
      | "PAYPAL_UNAVAILABLE"
      | "PAYPAL_RESPONSE_INVALID"
      | "PAYPAL_OUTCOME_UNKNOWN"
      | "PAYPAL_REQUEST_REJECTED"
      | "PAYER_APPROVAL_REQUIRED"
      | "CART_MANDATE_MISMATCH",
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
  /** Server-owned failure code (never provider free text). */
  readonly failureCode: string | null;
  /** Safe PayPal reason code for a held or payer-action state. */
  readonly providerStatusReason: string | null;
  /** Validated PayPal redirect when the payer must act before capture. */
  readonly payerActionUrl: string | null;
  /** "vault" when paid buyer-not-present with a saved PayPal payment method. */
  readonly paymentSource: "checkout" | "vault";
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
    readonly providerInitiated: boolean;
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
  const awaitingPayer =
    payment.status === PaymentStatus.CREATED || payment.status === PaymentStatus.APPROVED;
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
    failureCode: payment.failureCode,
    providerStatusReason: payment.providerStatusReason,
    payerActionUrl: awaitingPayer ? payment.payerActionUrl : null,
    paymentSource: payment.paymentSource === PaymentSource.VAULT ? "vault" : "checkout",
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
      providerInitiated: refund.providerInitiated,
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

function gatewayHosts(context: PaymentServiceContext): PayPalEnvironmentHosts {
  return context.paypal?.hosts ?? PAYPAL_ENVIRONMENTS.sandbox;
}

function isAllowedApprovalUrl(value: string, hosts: PayPalEnvironmentHosts): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      hosts.approvalHosts.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function safeApprovalUrl(value: string | null, hosts: PayPalEnvironmentHosts): string | null {
  if (value === null) return null;
  if (!isAllowedApprovalUrl(value, hosts) || value.length > 2048) {
    throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  }
  return value;
}

function safeReason(value: string | null | undefined): string | null {
  return typeof value === "string" && SAFE_REASON_PATTERN.test(value) ? value : null;
}

/** Line items let the buyer see what is being paid; omitted if facts disagree. */
function orderItems(
  payment: PaymentReceipt,
): Pick<CreateOrderInput, "items" | "shippingMinor" | "taxMinor"> {
  const proposal = payment.proposal;
  const snapshot = proposal.productSnapshot;
  if (
    proposal.total !== payment.amount ||
    proposal.subtotal !== snapshot.price * BigInt(proposal.quantity) ||
    proposal.total !== proposal.subtotal + proposal.shipping + proposal.tax
  ) {
    return {};
  }
  const sku = metadataDemoSku(snapshot.metadata);
  return {
    items: [
      {
        name: snapshot.title.trim().slice(0, 127) || "MandatePay purchase",
        ...(sku ? { sku: sku.slice(0, 127) } : {}),
        quantity: proposal.quantity,
        unitAmountMinor: toMinorUnits(safeAmount(snapshot.price, "item price")),
      },
    ],
    shippingMinor: toMinorUnits(safeAmount(proposal.shipping, "shipping")),
    taxMinor: toMinorUnits(safeAmount(proposal.tax, "tax")),
  };
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

/** The order's single capture after amount/binding checks, in any status. */
function captureFromOrder(order: PayPalOrder, payment: PaymentReceipt): PayPalCapture | null {
  const units = order.purchase_units ?? [];
  if (units.length !== 1) return null;
  const captures = units[0]?.payments?.captures ?? [];
  if (captures.length !== 1) return null;
  const parsed = PayPalCaptureSchema.safeParse(captures[0]);
  if (!parsed.success) return null;
  try {
    validateProviderCaptureFacts(parsed.data, payment);
    return parsed.data;
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

/**
 * Verifies the signed closed cart mandate against authoritative server facts
 * before any PayPal order request (see services/mandate-credentials.ts).
 */
async function enforceCartMandate(
  context: PaymentServiceContext,
  user: Owner,
  proposalId: string,
  payment?: { amount: bigint; currency: string },
) {
  try {
    await assertCartMandate(context.database, user.id, proposalId, payment);
  } catch (error) {
    if (error instanceof CartMandateMismatchError) {
      throw new PaymentServiceError("CART_MANDATE_MISMATCH", 409);
    }
    throw error;
  }
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
      terminalUnpaidStatuses.includes(proposal.payment.status))
  ) {
    return {
      payment: paymentDTO(await receiptForUser(context.database, user.id, proposal.payment.id)),
      approvalUrl: null,
      pending: false,
    };
  }
  if (!proposal.payment?.paypalOrderId) await assertNewCheckout(context.database);
  const authoritative = await authoritativeDemoProduct(context, proposal.productSnapshot);
  // Refuse a tampered cart before a payment row or reservation is claimed.
  if (!proposal.payment?.paypalOrderId && proposal.status === ProposalStatus.AUTHORIZED) {
    await enforceCartMandate(context, user, proposalId);
  }

  const claimed = await context.database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const existing = await tx.payment.findFirst({
      where: { proposalId, userId: user.id, isSample: false },
      include: receiptInclude,
    });
    if (existing) {
      if (!existing.paypalOrderId && !terminalUnpaidStatuses.includes(existing.status)) {
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
      terminalUnpaidStatuses.includes(payment.status)
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
      approvalUrl = safeApprovalUrl(order.approvalUrl, gatewayHosts(context));
      if (!approvalUrl) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
    } catch (error) {
      if (!asPendingReceipt(error)) throw error;
      pending = true;
    }
    return { payment: paymentDTO(payment), approvalUrl, pending };
  }
  return createProviderOrder(context, user, claimed.payment);
}

/**
 * PayPal refused to create the order, so nothing exists at the provider. The
 * cached failure would be replayed for the old request ID; rotate it so an
 * explicit retry is a new request. The reservation keeps its normal expiry.
 */
async function rotateOrderRequest(context: PaymentServiceContext, user: Owner, paymentId: string) {
  await context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (current.paypalOrderId || current.status !== PaymentStatus.CREATED) return;
    await tx.payment.update({
      where: { id: current.id },
      data: { paypalOrderRequestId: randomUUID() },
    });
  });
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
  // The amount sent to PayPal must be the amount in the signed payment mandate.
  await enforceCartMandate(context, user, payment.proposalId, {
    amount: payment.amount,
    currency: payment.currency,
  });
  const input: CreateOrderInput = {
    amountMinor: toMinorUnits(safeAmount(payment.amount, "payment amount")),
    referenceId: payment.id,
    customId: payment.proposalId,
    requestId: payment.paypalOrderRequestId,
    returnUrl: expectedRedirect(context.appUrl, payment.id, "return"),
    cancelUrl: expectedRedirect(context.appUrl, payment.id, "cancel"),
    ...orderItems(payment),
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
    const approvalUrl = safeApprovalUrl(order.approvalUrl, gatewayHosts(context));
    if (!approvalUrl) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
    const persisted = await finalizeOrder(context, user, payment.id, order);
    return { payment: paymentDTO(persisted), approvalUrl, pending: false };
  } catch (error) {
    if (isDefinitivePayPalRejection(error)) {
      await rotateOrderRequest(context, user, payment.id);
      throw new PaymentServiceError("PAYPAL_REQUEST_REJECTED", 422);
    }
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
    // A capture already claimed was authorized when it was claimed. Replaying
    // its idempotent request never re-runs policy or deadline checks.
    if (current.status === PaymentStatus.CAPTURE_PENDING) {
      return { pending: current as PaymentReceipt } as const;
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
          // A payer re-approval after a funding-source rejection is a new event.
          dedupeKey: current.providerStatusReason
            ? `paypal-order-reapproved:${current.id}:${current.updatedAt.getTime()}`
            : `paypal-order-approved:${current.id}`,
          payload: { paymentId: current.id, proposalId: current.proposalId },
        },
      });
    }
    const pending = await tx.payment.update({
      where: { id: current.id },
      data: {
        status: PaymentStatus.CAPTURE_PENDING,
        providerStatusReason: null,
        payerActionUrl: null,
      },
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
        dedupeKey: current.providerStatusReason
          ? `paypal-capture-requested:${current.id}:${current.updatedAt.getTime()}`
          : `paypal-capture-requested:${current.id}`,
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
    // A completed provider capture is recorded from any unpaid state.
    if (!unpaidOpenStatuses.includes(current.status)) {
      throw new DatabaseError("INVALID_STATE", "Payment is not awaiting capture completion.");
    }
    if (current.paypalCaptureId && current.paypalCaptureId !== capture.id) {
      throw new DatabaseError("CONFLICT", "Payment is bound to another PayPal capture.");
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
        providerStatusReason: null,
        payerActionUrl: null,
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

/**
 * Ends an unpaid payment in one transaction: payment FAILED/DENIED, proposal
 * FAILED and an active reservation RELEASED, each with an audit event. A
 * payment that already has a provider capture is never failed here.
 */
async function closeUnpaidPayment(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  input: {
    status: typeof PaymentStatus.FAILED | typeof PaymentStatus.DENIED;
    failureCode: string;
    providerIssue: string | null;
    debugId?: string | null;
    paypalCaptureId?: string | null;
    dedupe: string;
  },
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (settledPaymentStatuses.includes(current.status)) return current;
    if (terminalUnpaidStatuses.includes(current.status)) return current;
    if (!unpaidOpenStatuses.includes(current.status)) {
      throw new DatabaseError("INVALID_STATE", "Payment is not awaiting a capture outcome.");
    }
    if (current.paypalCaptureId && current.paypalCaptureId !== input.paypalCaptureId) {
      // A provider capture exists; only its own authoritative outcome can end it.
      return current;
    }
    const reservation = await tx.spendReservation.findUnique({
      where: { proposalId: current.proposalId },
    });
    if (reservation?.status === ReservationStatus.CONSUMED) {
      throw new DatabaseError("INVALID_STATE", "The payment reservation is already consumed.");
    }
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: {
        status: input.status,
        failureCode: input.failureCode.slice(0, 128),
        providerStatusReason: safeReason(input.providerIssue),
        payerActionUrl: null,
      },
      include: receiptInclude,
    });
    await tx.purchaseProposal.update({
      where: { id: current.proposalId },
      data: { status: ProposalStatus.FAILED },
    });
    if (reservation?.status === ReservationStatus.ACTIVE) {
      await tx.spendReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.RELEASED, releasedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: AuditEventType.SPEND_RESERVATION_RELEASED,
          entityType: AuditEntityType.SPEND_RESERVATION,
          entityId: reservation.id,
          dedupeKey: `paypal-reservation-released:${reservation.id}`,
          payload: {
            paymentId: current.id,
            proposalId: current.proposalId,
            reason: input.failureCode.slice(0, 128),
          },
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_FAILED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-payment-failed:${current.id}:${input.dedupe}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          reason: input.failureCode.slice(0, 128),
          providerIssue: safeReason(input.providerIssue),
          ...(input.debugId ? { providerDebugId: input.debugId } : {}),
          ...(input.paypalCaptureId ? { providerCaptureId: input.paypalCaptureId } : {}),
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
  const failed = capture.status === "FAILED";
  return closeUnpaidPayment(context, user, paymentId, {
    status: failed ? PaymentStatus.FAILED : PaymentStatus.DENIED,
    failureCode: failed ? "PAYPAL_CAPTURE_FAILED" : "PAYPAL_CAPTURE_DECLINED",
    providerIssue: safeReason(capture.status_details?.reason),
    paypalCaptureId: capture.id,
    dedupe: `capture:${capture.id}`,
  });
}

/** PayPal accepted the capture but holds it (for example PENDING_REVIEW). */
async function recordPendingCapture(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  capture: PayPalCapture,
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (!unpaidOpenStatuses.includes(current.status)) return current;
    if (current.paypalCaptureId && current.paypalCaptureId !== capture.id) {
      throw new DatabaseError("CONFLICT", "Payment is bound to another PayPal capture.");
    }
    const reason = safeReason(capture.status_details?.reason) ?? "PENDING";
    if (
      current.status === PaymentStatus.CAPTURE_PENDING &&
      current.paypalCaptureId === capture.id &&
      current.providerStatusReason === reason
    ) {
      return current;
    }
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: {
        status: PaymentStatus.CAPTURE_PENDING,
        paypalCaptureId: capture.id,
        providerStatusReason: reason,
        payerActionUrl: null,
      },
      include: receiptInclude,
    });
    if (current.proposal.status !== ProposalStatus.PAYMENT_PENDING) {
      await tx.purchaseProposal.update({
        where: { id: current.proposalId },
        data: { status: ProposalStatus.PAYMENT_PENDING },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_CAPTURE_REQUESTED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-capture-held:${current.id}:${capture.id}:${reason}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          paypalCaptureId: capture.id,
          providerStatus: "PENDING",
          providerStatusReason: reason,
        },
      },
    });
    return updated;
  });
}

/**
 * Returns a capture-pending payment to the payer. A definitive payer-side
 * rejection rotates the capture request ID (PayPal would replay the cached
 * failure for the old one); an unconfirmed stale capture keeps it so a later
 * attempt is still an idempotent replay.
 */
async function returnToPayer(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  input: {
    status: typeof PaymentStatus.CREATED | typeof PaymentStatus.APPROVED;
    reason: string;
    payerActionUrl: string | null;
    rotateRequestId: boolean;
    expectedRequestId: string | null;
    debugId?: string | null;
  },
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    if (current.status !== PaymentStatus.CAPTURE_PENDING) return current;
    if (current.paypalCaptureId) return current;
    if (
      input.expectedRequestId !== null &&
      current.paypalCaptureRequestId !== input.expectedRequestId
    ) {
      return current;
    }
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: {
        status: input.status,
        providerStatusReason: safeReason(input.reason),
        payerActionUrl: input.payerActionUrl,
        ...(input.rotateRequestId ? { paypalCaptureRequestId: randomUUID() } : {}),
      },
      include: receiptInclude,
    });
    if (current.proposal.status === ProposalStatus.PAYMENT_PENDING) {
      await tx.purchaseProposal.update({
        where: { id: current.proposalId },
        data: { status: ProposalStatus.PAYPAL_ORDER_CREATED },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: input.rotateRequestId
          ? AuditEventType.PAYMENT_FAILED
          : AuditEventType.PAYPAL_ORDER_APPROVED,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `paypal-capture-returned:${current.id}:${current.updatedAt.getTime()}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          reason: safeReason(input.reason),
          recoverable: true,
          paymentStatus: input.status,
          ...(input.debugId ? { providerDebugId: input.debugId } : {}),
        },
      },
    });
    return updated;
  });
}

function payerRedirect(context: PaymentServiceContext, order: PayPalOrder | null, orderId: string) {
  const hosts = gatewayHosts(context);
  const candidates = [
    order?.approvalUrl ?? null,
    context.paypal?.checkoutUrl ? safeCheckoutUrl(context, orderId) : null,
  ];
  return (
    candidates.find(
      (value): value is string =>
        typeof value === "string" && value.length <= 2048 && isAllowedApprovalUrl(value, hosts),
    ) ?? null
  );
}

function safeCheckoutUrl(context: PaymentServiceContext, orderId: string): string | null {
  try {
    return context.paypal?.checkoutUrl?.(orderId) ?? null;
  } catch {
    return null;
  }
}

async function hydrateCapture(
  context: PaymentServiceContext,
  capture: PayPalCapture,
  payment: PaymentReceipt,
): Promise<PayPalCapture> {
  if (capture.create_time || !context.paypal?.getCapture) return capture;
  const hydrated = await context.paypal.getCapture(capture.id);
  if (hydrated.id !== capture.id) throw new PaymentServiceError("PAYPAL_RESPONSE_INVALID");
  validateProviderCaptureFacts(hydrated, payment);
  return hydrated;
}

type CaptureResult = { readonly payment: PaymentReceipt; readonly pending: boolean };

/** Applies a validated provider capture (any status) to a claimed payment. */
async function applyProviderCapture(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  capture: PayPalCapture,
): Promise<CaptureResult> {
  validateProviderCaptureFacts(capture, payment);
  if (capture.status === "DECLINED" || capture.status === "FAILED") {
    return {
      payment: await finalizeDeclinedCapture(context, user, payment.id, capture),
      pending: false,
    };
  }
  if (capture.status === "PENDING") {
    return {
      payment: await recordPendingCapture(context, user, payment.id, capture),
      pending: true,
    };
  }
  const completed = await hydrateCapture(context, capture, payment);
  validateProviderCapture(completed, payment);
  return {
    payment: await finalizeCapture(
      context,
      user,
      payment.id,
      completed,
      providerCaptureTimestamp(completed),
    ),
    pending: false,
  };
}

/** Records the outcome when PayPal definitively refused the capture request. */
async function applyCaptureRejection(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  requestId: string,
  error: PayPalProviderError,
): Promise<CaptureResult> {
  const orderId = payment.paypalOrderId;
  if (!orderId || !context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  const issue = safeReason(error.issue) ?? safeReason(error.providerName);

  if (issue === "ORDER_ALREADY_CAPTURED") {
    // The capture exists; read it back instead of capturing again.
    try {
      const order = await context.paypal.getOrder(orderId);
      validateProviderOrder(order, payment, orderId);
      const capture = captureFromOrder(order, payment);
      if (capture) return await applyProviderCapture(context, user, payment, capture);
    } catch (cause) {
      if (!asPendingReceipt(cause)) throw cause;
    }
    return { payment: await currentReceipt(context, payment.id, user.id), pending: true };
  }

  if (issue === "ORDER_NOT_APPROVED" || (issue !== null && PAYER_ACTION_ISSUES.has(issue))) {
    let order: PayPalOrder | null = null;
    try {
      order = await context.paypal.getOrder(orderId);
      validateProviderOrder(order, payment, orderId);
    } catch (cause) {
      if (!asPendingReceipt(cause)) throw cause;
      order = null;
    }
    return {
      payment: await returnToPayer(context, user, payment.id, {
        status: issue === "ORDER_NOT_APPROVED" ? PaymentStatus.CREATED : PaymentStatus.APPROVED,
        reason: issue,
        payerActionUrl: payerRedirect(context, order, orderId),
        rotateRequestId: true,
        expectedRequestId: requestId,
        debugId: error.debugId,
      }),
      pending: false,
    };
  }

  return {
    payment: await closeUnpaidPayment(context, user, payment.id, {
      status: PaymentStatus.FAILED,
      failureCode: `PAYPAL_CAPTURE_REJECTED${issue ? `:${issue}` : ""}`,
      providerIssue: issue,
      debugId: error.debugId,
      dedupe: `request:${requestId}`,
    }),
    pending: false,
  };
}

async function executeCapture(
  context: PaymentServiceContext,
  user: Owner,
  pending: PaymentReceipt,
  orderId: string,
): Promise<CaptureResult> {
  if (!context.paypal || !pending.paypalCaptureRequestId) {
    throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  }
  const requestId = pending.paypalCaptureRequestId;
  try {
    let providerRequest = inFlightCaptureRequests.get(requestId);
    if (!providerRequest) {
      providerRequest = context.paypal.captureOrder(orderId, requestId);
      inFlightCaptureRequests.set(requestId, providerRequest);
    }
    const capture = await providerRequest;
    return await applyProviderCapture(context, user, pending, capture);
  } catch (error) {
    if (isDefinitivePayPalRejection(error)) {
      return applyCaptureRejection(context, user, pending, requestId, error);
    }
    if (!asPendingReceipt(error)) throw error;
    return { payment: await currentReceipt(context, pending.id, user.id), pending: true };
  } finally {
    inFlightCaptureRequests.delete(requestId);
  }
}

function captureResponse(result: CaptureResult) {
  return { payment: paymentDTO(result.payment), pending: result.pending };
}

export async function capturePaypalOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentOrOrderId: string,
) {
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  let payment = await receiptForUser(context.database, user.id, paymentOrOrderId);
  if (
    settledPaymentStatuses.includes(payment.status) ||
    terminalUnpaidStatuses.includes(payment.status)
  ) {
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
  if (order.status === "COMPLETED") {
    const capture = captureFromOrder(order, payment);
    if (capture) {
      try {
        return captureResponse(await applyProviderCapture(context, user, payment, capture));
      } catch (error) {
        if (!asPendingReceipt(error)) throw error;
      }
    }
    const current = await currentReceipt(context, payment.id, user.id);
    return { payment: paymentDTO(current), pending: true };
  }
  if (order.status === "VOIDED") {
    return captureResponse({
      payment: await closeUnpaidPayment(context, user, payment.id, {
        status: PaymentStatus.FAILED,
        failureCode: "PAYPAL_ORDER_VOIDED",
        providerIssue: "ORDER_VOIDED",
        dedupe: "order-voided",
      }),
      pending: false,
    });
  }

  if (payment.status === PaymentStatus.CAPTURE_PENDING) {
    // Already claimed and authorized: replay the same idempotent request
    // without re-running policy, catalog or proposal-expiry checks.
    if (order.status === "APPROVED") {
      return captureResponse(await executeCapture(context, user, payment, order.id));
    }
    return { payment: paymentDTO(payment), pending: true };
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
  return captureResponse(await executeCapture(context, user, claimed.pending, order.id));
}

/*
 * Autonomous (buyer-not-present) payment with a saved PayPal Vault token.
 *
 * Executes only for a proposal that AgentGuard re-evaluates as ALLOW inside the
 * same locked claim transaction (User -> Mandate -> Proposal -> Payment), while
 * the user's autonomy, the platform's autonomy and checkout are on, and the
 * user's saved PayPal method is ACTIVE. Human-approved proposals, Channel3
 * products and anything above the automatic limit keep the normal checkout.
 */

export type AutopayOutcome = "PAID" | "PENDING" | "FALLBACK" | "NOT_ELIGIBLE" | "FAILED";

export interface AutopayResult {
  readonly outcome: AutopayOutcome;
  /** Server-owned reason code (never provider free text). */
  readonly reason: string | null;
  readonly payment: PaymentDTO | null;
}

/**
 * Definitive PayPal rejections after which the saved method cannot be used for
 * this order but the buyer can still approve a normal checkout. Nothing was
 * charged, so the payment returns to the buyer-approval path.
 */
const VAULT_FALLBACK_ISSUES = new Set([
  "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE",
  "PAYER_ACTION_REQUIRED",
  "INSTRUMENT_DECLINED",
  "PAYMENT_SOURCE_CANNOT_BE_USED",
  "PAYMENT_SOURCE_DECLINED_BY_PROCESSOR",
  "PAYMENT_SOURCE_INFO_CANNOT_BE_VERIFIED",
  "INVALID_RESOURCE_ID",
  "RESOURCE_NOT_FOUND",
]);

const inFlightVaultOrders = new Map<string, Promise<PayPalOrder>>();

function vaultConfigured(context: PaymentServiceContext) {
  return Boolean(context.vault && context.paypal?.createVaultOrder);
}

type GateReader = Pick<TransactionClient, "user" | "paymentProfile" | "platformSetting">;

/** Eligibility facts shared by the read-only preview and the locked claim. */
async function autopayGate(
  db: GateReader,
  userId: string,
): Promise<{ readonly reason: string } | { readonly ciphertext: string }> {
  const profile = await db.paymentProfile.findUnique({ where: { userId } });
  if (profile?.status !== PaymentProfileStatus.ACTIVE || !profile.paypalVaultIdEncrypted) {
    return { reason: "NO_SAVED_PAYMENT_METHOD" };
  }
  const account = await db.user.findUnique({
    where: { id: userId },
    select: { globalAutonomousPurchasingEnabled: true, disabledAt: true },
  });
  if (!account || account.disabledAt) return { reason: "ACCOUNT_DISABLED" };
  // Fail closed: an unreadable settings store disables autonomous execution.
  const controls = await readPlatformControlsFailClosed(db);
  if (controls["platform.maintenanceMode"]) return { reason: "MAINTENANCE" };
  if (!controls["payments.checkoutEnabled"]) return { reason: "CHECKOUT_DISABLED" };
  if (!controls["payments.autonomyEnabledGlobally"]) return { reason: "PLATFORM_AUTONOMY_OFF" };
  if (!account.globalAutonomousPurchasingEnabled) return { reason: "AUTONOMY_OFF" };
  return { ciphertext: profile.paypalVaultIdEncrypted };
}

function withinAutomaticLimit(canonicalRules: Prisma.JsonValue, total: bigint) {
  const rules = CanonicalMandateSchema.safeParse(canonicalRules);
  return rules.success && total <= BigInt(rules.data.autoSpendLimit);
}

function decisionReason(decision: { decision: string; reasonCodes: unknown }) {
  const codes = Array.isArray(decision.reasonCodes) ? decision.reasonCodes : [];
  if (decision.decision === "BLOCK") return "BLOCKED";
  if (codes.includes("GLOBAL_AUTONOMY_DISABLED")) return "AUTONOMY_OFF";
  if (codes.includes("AUTO_SPEND_THRESHOLD_EXCEEDED")) {
    return "ABOVE_AUTOMATIC_LIMIT";
  }
  return "REQUIRES_APPROVAL";
}

async function autopayProposalFacts(database: DatabaseClient, userId: string, proposalId: string) {
  const proposal = await database.purchaseProposal.findFirst({
    where: { id: proposalId, userId, isSample: false },
    include: {
      productSnapshot: true,
      payment: true,
      approval: true,
      mandateVersion: true,
      policyDecisions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!proposal || proposal.payment?.isSample) {
    throw new DatabaseError("NOT_FOUND", "Purchase proposal was not found.");
  }
  return proposal;
}

type AutopayProposalFacts = Awaited<ReturnType<typeof autopayProposalFacts>>;

/** The first reason this proposal cannot be paid automatically, without side effects. */
async function autopayIneligibility(
  context: PaymentServiceContext,
  userId: string,
  proposal: AutopayProposalFacts,
): Promise<string | null> {
  if (proposal.status !== ProposalStatus.AUTHORIZED) return "PROPOSAL_NOT_AUTHORIZED";
  if (proposal.productSnapshot.source !== "demo") return "PRODUCT_NOT_ELIGIBLE";
  if (!withinAutomaticLimit(proposal.mandateVersion.canonicalRules, proposal.total)) {
    return "ABOVE_AUTOMATIC_LIMIT";
  }
  // Human-approved proposals keep the normal PayPal checkout.
  if (proposal.approval?.decision === ApprovalDecision.APPROVED) return "HUMAN_APPROVED";
  if (proposal.policyDecisions[0]?.decision !== PolicyDecisionType.ALLOW) {
    return "REQUIRES_APPROVAL";
  }
  if (!vaultConfigured(context)) return "VAULT_UNAVAILABLE";
  const gate = await autopayGate(context.database, userId);
  return "reason" in gate ? gate.reason : null;
}

function notEligible(reason: string, payment: PaymentReceipt | null = null): AutopayResult {
  return { outcome: "NOT_ELIGIBLE", reason, payment: payment ? paymentDTO(payment) : null };
}

async function recordAutonomousAudit(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  eventType:
    | typeof AuditEventType.AUTONOMOUS_PAYMENT_COMPLETED
    | typeof AuditEventType.AUTONOMOUS_PAYMENT_FAILED,
  extra: Record<string, string | number | null> = {},
) {
  await context.database.auditEvent.createMany({
    data: [
      {
        userId: user.id,
        eventType,
        entityType: AuditEntityType.PAYMENT,
        entityId: payment.id,
        dedupeKey: `${eventType.toLowerCase()}:${payment.id}`,
        payload: {
          paymentId: payment.id,
          proposalId: payment.proposalId,
          paymentSource: "vault",
          paymentStatus: payment.status,
          amount: Number(payment.amount),
          currency: payment.currency,
          ...extra,
        },
      },
    ],
    skipDuplicates: true,
  });
}

/** Maps a payment's server state to the autopay outcome, recording terminal audits once. */
async function autopayResult(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  pendingReason: string | null = null,
): Promise<AutopayResult> {
  if (settledPaymentStatuses.includes(payment.status)) {
    if (payment.paymentSource === PaymentSource.VAULT) {
      await recordAutonomousAudit(
        context,
        user,
        payment,
        AuditEventType.AUTONOMOUS_PAYMENT_COMPLETED,
        { paypalCaptureId: payment.paypalCaptureId },
      );
    }
    return { outcome: "PAID", reason: null, payment: paymentDTO(payment) };
  }
  if (terminalUnpaidStatuses.includes(payment.status)) {
    if (payment.paymentSource === PaymentSource.VAULT) {
      await recordAutonomousAudit(
        context,
        user,
        payment,
        AuditEventType.AUTONOMOUS_PAYMENT_FAILED,
        {
          reason: payment.failureCode,
        },
      );
    }
    return { outcome: "FAILED", reason: payment.failureCode, payment: paymentDTO(payment) };
  }
  if (payment.paymentSource === PaymentSource.CHECKOUT) {
    return {
      outcome: "FALLBACK",
      reason: payment.providerStatusReason ?? "PAYER_ACTION_REQUIRED",
      payment: paymentDTO(payment),
    };
  }
  return {
    outcome: "PENDING",
    reason: pendingReason ?? payment.providerStatusReason,
    payment: paymentDTO(payment),
  };
}

/**
 * Returns an unpaid Vault payment to the normal buyer-approval checkout. A
 * PayPal order that needs payer action is kept (the buyer approves it); after a
 * definitive refusal nothing exists at PayPal, so the order request ID rotates.
 */
async function fallbackToCheckout(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  input: { order: PayPalOrder | null; reason: string; debugId?: string | null },
) {
  return context.database.$transaction(async (tx) => {
    const current = await lockPaymentInOrder(tx, user.id, paymentId);
    const returnedToPayer =
      current.status === PaymentStatus.CREATED || current.status === PaymentStatus.APPROVED;
    if (
      current.paymentSource !== PaymentSource.VAULT ||
      current.paypalCaptureId ||
      (current.status !== PaymentStatus.CAPTURE_PENDING && !returnedToPayer)
    ) {
      return current;
    }
    const orderId = input.order?.id ?? current.paypalOrderId;
    const updated = await tx.payment.update({
      where: { id: current.id },
      data: returnedToPayer
        ? { paymentSource: PaymentSource.CHECKOUT }
        : {
            status: PaymentStatus.CREATED,
            paymentSource: PaymentSource.CHECKOUT,
            providerStatusReason: safeReason(input.reason),
            payerActionUrl: orderId ? payerRedirect(context, input.order, orderId) : null,
            ...(orderId ? {} : { paypalOrderRequestId: randomUUID() }),
          },
      include: receiptInclude,
    });
    if (!returnedToPayer) {
      await tx.purchaseProposal.update({
        where: { id: current.proposalId },
        data: {
          status: orderId ? ProposalStatus.PAYPAL_ORDER_CREATED : ProposalStatus.AUTHORIZED,
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.AUTONOMOUS_PAYMENT_FALLBACK,
        entityType: AuditEntityType.PAYMENT,
        entityId: current.id,
        dedupeKey: `autonomous-payment-fallback:${current.id}`,
        payload: {
          paymentId: current.id,
          proposalId: current.proposalId,
          reason: safeReason(input.reason),
          paypalOrderId: orderId ?? null,
          charged: false,
          ...(input.debugId ? { providerDebugId: input.debugId } : {}),
        },
      },
    });
    return updated;
  });
}

/** Applies a validated, locally bound Vault order in any provider status. */
async function applyVaultOrder(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  order: PayPalOrder,
): Promise<AutopayResult> {
  if (order.status === "COMPLETED") {
    const capture = captureFromOrder(order, payment);
    if (!capture) return autopayResult(context, user, payment, "PAYPAL_OUTCOME_UNKNOWN");
    const result = await applyProviderCapture(context, user, payment, capture);
    return autopayResult(context, user, result.payment);
  }
  if (order.status === "APPROVED" || order.status === "CREATED") {
    // PayPal accepted the saved method without capturing: capture through the
    // existing path with the payment's stable capture request ID.
    const result = await executeCapture(context, user, payment, order.id);
    if (
      result.payment.status === PaymentStatus.CREATED ||
      result.payment.status === PaymentStatus.APPROVED
    ) {
      // PayPal refused the capture for payer action; it is back with the buyer.
      return autopayResult(
        context,
        user,
        await fallbackToCheckout(context, user, payment.id, {
          order,
          reason: result.payment.providerStatusReason ?? "PAYER_ACTION_REQUIRED",
        }),
      );
    }
    return autopayResult(context, user, result.payment);
  }
  if (order.status === "PAYER_ACTION_REQUIRED") {
    return autopayResult(
      context,
      user,
      await fallbackToCheckout(context, user, payment.id, {
        order,
        reason: "PAYER_ACTION_REQUIRED",
      }),
    );
  }
  if (order.status === "VOIDED") {
    return autopayResult(
      context,
      user,
      await closeUnpaidPayment(context, user, payment.id, {
        status: PaymentStatus.FAILED,
        failureCode: "PAYPAL_ORDER_VOIDED",
        providerIssue: "ORDER_VOIDED",
        dedupe: "order-voided",
      }),
    );
  }
  return autopayResult(context, user, payment, "PAYPAL_OUTCOME_UNKNOWN");
}

/** Creates (or idempotently replays) the buyer-not-present Vault order for a claimed payment. */
async function executeVaultOrder(
  context: PaymentServiceContext,
  user: Owner,
  payment: PaymentReceipt,
  ciphertext: string,
): Promise<AutopayResult> {
  if (!context.paypal?.createVaultOrder || !context.vault || !payment.paypalOrderRequestId) {
    throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  }
  let vaultId: string;
  try {
    vaultId = context.vault.decrypt(user.id, ciphertext);
  } catch (error) {
    if (!(error instanceof VaultCipherError)) throw error;
    // Nothing was sent to PayPal: the buyer can still approve a normal checkout.
    return autopayResult(
      context,
      user,
      await fallbackToCheckout(context, user, payment.id, {
        order: null,
        reason: "VAULT_TOKEN_UNREADABLE",
      }),
    );
  }
  const requestId = payment.paypalOrderRequestId;
  try {
    let providerRequest = inFlightVaultOrders.get(requestId);
    if (!providerRequest) {
      providerRequest = context.paypal.createVaultOrder({
        amountMinor: toMinorUnits(safeAmount(payment.amount, "payment amount")),
        referenceId: payment.id,
        customId: payment.proposalId,
        requestId,
        vaultId,
        ...orderItems(payment),
      });
      inFlightVaultOrders.set(requestId, providerRequest);
    }
    let order = await providerRequest;
    const createdOrderId = order.id;
    if (!order.purchase_units || order.purchase_units.length !== 1) {
      order = await context.paypal.getOrder(order.id);
    }
    validateProviderOrder(order, payment, createdOrderId);
    const bound = await finalizeOrder(context, user, payment.id, order);
    return await applyVaultOrder(context, user, bound, order);
  } catch (error) {
    if (isDefinitivePayPalRejection(error)) {
      const issue = safeReason(error.issue) ?? safeReason(error.providerName);
      if (issue !== null && VAULT_FALLBACK_ISSUES.has(issue)) {
        return autopayResult(
          context,
          user,
          await fallbackToCheckout(context, user, payment.id, {
            order: null,
            reason: issue,
            debugId: error.debugId,
          }),
        );
      }
      return autopayResult(
        context,
        user,
        await closeUnpaidPayment(context, user, payment.id, {
          status: PaymentStatus.FAILED,
          failureCode: `PAYPAL_VAULT_ORDER_REJECTED${issue ? `:${issue}` : ""}`,
          providerIssue: issue,
          debugId: error.debugId,
          dedupe: `vault-order:${requestId}`,
        }),
      );
    }
    if (!asPendingReceipt(error)) throw error;
    // Unknown outcome: the payment stays CAPTURE_PENDING with its reservation
    // held. A retry replays the same PayPal-Request-Id, and a verified webhook
    // can bind the order through its reference_id.
    return autopayResult(
      context,
      user,
      await currentReceipt(context, payment.id, user.id),
      "PAYPAL_OUTCOME_UNKNOWN",
    );
  } finally {
    inFlightVaultOrders.delete(requestId);
  }
}

/** Continues an existing Vault payment without ever creating a second order or capture. */
async function resumeVaultPayment(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
): Promise<AutopayResult> {
  const payment = await receiptForUser(context.database, user.id, paymentId);
  if (
    payment.paymentSource !== PaymentSource.VAULT ||
    payment.status !== PaymentStatus.CAPTURE_PENDING
  ) {
    return autopayResult(context, user, payment);
  }
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  if (!payment.paypalOrderId) {
    const profile = await context.database.paymentProfile.findUnique({
      where: { userId: user.id },
    });
    // A method removed after the claim is never used for a new provider request.
    if (profile?.status !== PaymentProfileStatus.ACTIVE || !profile.paypalVaultIdEncrypted) {
      return autopayResult(context, user, payment, "SAVED_METHOD_REMOVED");
    }
    return executeVaultOrder(context, user, payment, profile.paypalVaultIdEncrypted);
  }
  try {
    const order = await context.paypal.getOrder(payment.paypalOrderId);
    validateProviderOrder(order, payment, payment.paypalOrderId);
    return await applyVaultOrder(context, user, payment, order);
  } catch (error) {
    if (!asPendingReceipt(error)) throw error;
    return autopayResult(
      context,
      user,
      await currentReceipt(context, payment.id, user.id),
      "PAYPAL_OUTCOME_UNKNOWN",
    );
  }
}

/**
 * How long after the claim the payment reconcile worker may replay an unbound
 * Vault order request. PayPal returns the original result for a repeated
 * PayPal-Request-Id only while it still retains that key (hours, not days, for
 * Orders v2); a replay after that could create a second order and charge, so
 * older payments are held for an operator instead.
 */
export const VAULT_ORDER_REPLAY_WINDOW_MS = 3 * 60 * 60_000;

export interface UnboundVaultReplay {
  /** Server reason the payment was kept pending without any PayPal call, if held. */
  readonly heldReason: string | null;
  readonly result: AutopayResult;
}

/**
 * Worker continuation of a Vault payment whose create-order outcome is unknown
 * (timeout or 5xx before PayPal returned an order id). The same idempotent
 * request (same PayPal-Request-Id) is replayed only while the saved method is
 * ACTIVE, the account, platform and user autonomy switches still allow
 * autonomous checkout, the mandate is ACTIVE and the request is inside the
 * replay window; PayPal then returns the original order rather than charging
 * again.
 *
 * Otherwise nothing is sent and the payment is NOT failed: without an order id
 * we cannot tell whether the first request already charged the buyer, so
 * releasing the reservation could free money that PayPal has captured. The
 * payment stays CAPTURE_PENDING with its hold, a verified webhook can still
 * bind it by reference_id, and System health counts it for an operator.
 */
export async function replayUnboundVaultOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  options: { readonly now?: Date; readonly replayWindowMs?: number } = {},
): Promise<UnboundVaultReplay> {
  const payment = await receiptForUser(context.database, user.id, paymentId);
  if (
    payment.paymentSource !== PaymentSource.VAULT ||
    payment.status !== PaymentStatus.CAPTURE_PENDING ||
    payment.paypalOrderId
  ) {
    // Resolved or bound meanwhile: the read-only reconcile path owns it now.
    return { heldReason: null, result: await autopayResult(context, user, payment) };
  }
  const hold = async (reason: string): Promise<UnboundVaultReplay> => ({
    heldReason: reason,
    result: await autopayResult(context, user, payment, reason),
  });
  const now = options.now ?? new Date();
  const windowMs = options.replayWindowMs ?? VAULT_ORDER_REPLAY_WINDOW_MS;
  if (now.getTime() - payment.createdAt.getTime() > windowMs) return hold("REPLAY_WINDOW_ELAPSED");
  if (!vaultConfigured(context)) return hold("VAULT_UNAVAILABLE");
  const mandate = await context.database.mandate.findUnique({
    where: { id: payment.mandateId },
    select: { status: true },
  });
  if (mandate?.status !== MandateStatus.ACTIVE) return hold("MANDATE_NOT_ACTIVE");
  const gate = await autopayGate(context.database, user.id);
  if ("reason" in gate) return hold(gate.reason);
  return {
    heldReason: null,
    result: await executeVaultOrder(context, user, payment, gate.ciphertext),
  };
}

export async function autopayProposal(
  context: PaymentServiceContext,
  user: Owner,
  proposalId: string,
): Promise<AutopayResult> {
  const proposal = await autopayProposalFacts(context.database, user.id, proposalId);
  if (proposal.payment) {
    if (proposal.payment.paymentSource !== PaymentSource.VAULT) {
      return notEligible(
        "CHECKOUT_STARTED",
        await receiptForUser(context.database, user.id, proposal.payment.id),
      );
    }
    return resumeVaultPayment(context, user, proposal.payment.id);
  }
  const reason = await autopayIneligibility(context, user.id, proposal);
  if (reason) return notEligible(reason);

  let authoritative: { price: bigint; currency: "USD" };
  try {
    authoritative = await authoritativeDemoProduct(context, proposal.productSnapshot);
  } catch (error) {
    if (error instanceof DatabaseError) return notEligible("PRODUCT_CHANGED");
    throw error;
  }
  // A saved-PayPal charge needs the same signed cart as buyer-approved checkout.
  await enforceCartMandate(context, user, proposalId);

  const claimed = await context.database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const existing = await tx.payment.findFirst({
      where: { proposalId, userId: user.id, isSample: false },
      select: { id: true },
    });
    if (existing) return { kind: "existing", paymentId: existing.id } as const;
    // The saved method, autonomy and platform switches are re-read under the
    // user lock, which method removal and settings changes also take first.
    const gate = await autopayGate(tx, user.id);
    if ("reason" in gate) return { kind: "ineligible", reason: gate.reason } as const;
    const authorization = await revalidateAuthorizationInTransaction(
      tx,
      user,
      proposalId,
      authoritative,
    );
    if (authorization.decision.decision !== "ALLOW") {
      return { kind: "ineligible", reason: decisionReason(authorization.decision) } as const;
    }
    const approval = await tx.approval.findUnique({ where: { proposalId } });
    if (approval?.decision === ApprovalDecision.APPROVED) {
      return { kind: "ineligible", reason: "HUMAN_APPROVED" } as const;
    }
    if (
      !authorization.authorized ||
      !authorization.reservation ||
      !withinAutomaticLimit(
        authorization.proposal.mandateVersion.canonicalRules,
        authorization.proposal.total,
      )
    ) {
      return { kind: "ineligible", reason: "ABOVE_AUTOMATIC_LIMIT" } as const;
    }
    const payment = await tx.payment.create({
      data: {
        userId: user.id,
        mandateId: authorization.proposal.mandateId,
        proposalId: authorization.proposal.id,
        amount: authorization.proposal.total,
        currency: authorization.proposal.currency,
        // Claimed like a capture: the reservation stays held until PayPal's outcome is known.
        status: PaymentStatus.CAPTURE_PENDING,
        paymentSource: PaymentSource.VAULT,
        idempotencyKey: `paypal-payment:${authorization.proposal.id}`,
        paypalOrderRequestId: randomUUID(),
        paypalCaptureRequestId: randomUUID(),
      },
      include: receiptInclude,
    });
    await tx.purchaseProposal.update({
      where: { id: authorization.proposal.id },
      data: { status: ProposalStatus.PAYMENT_PENDING },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.AUTONOMOUS_PAYMENT_STARTED,
        entityType: AuditEntityType.PAYMENT,
        entityId: payment.id,
        dedupeKey: `autonomous-payment-started:${payment.id}`,
        payload: {
          paymentId: payment.id,
          proposalId: payment.proposalId,
          policyDecisionId: authorization.decision.id,
          amount: Number(payment.amount),
          currency: payment.currency,
          paymentSource: "vault",
        },
      },
    });
    return { kind: "claimed", payment, ciphertext: gate.ciphertext } as const;
  });

  if (claimed.kind === "ineligible") return notEligible(claimed.reason);
  if (claimed.kind === "existing") {
    const existing = await receiptForUser(context.database, user.id, claimed.paymentId);
    if (existing.paymentSource !== PaymentSource.VAULT) {
      return notEligible("CHECKOUT_STARTED", existing);
    }
    return resumeVaultPayment(context, user, existing.id);
  }
  return executeVaultOrder(context, user, claimed.payment, claimed.ciphertext);
}

export interface AutopayPreview {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly paymentMethodStatus: PaymentProfileStatus;
  readonly payment: {
    readonly id: string;
    readonly status: PaymentStatus;
    readonly paymentSource: "checkout" | "vault";
  } | null;
}

/** Read-only: whether autopay would be attempted now, and any existing payment. */
export async function autopayPreview(
  context: PaymentServiceContext,
  user: Owner,
  proposalId: string,
): Promise<AutopayPreview> {
  const proposal = await autopayProposalFacts(context.database, user.id, proposalId);
  const profile = await context.database.paymentProfile.findUnique({
    where: { userId: user.id },
    select: { status: true },
  });
  const payment = proposal.payment
    ? {
        id: proposal.payment.id,
        status: proposal.payment.status,
        paymentSource:
          proposal.payment.paymentSource === PaymentSource.VAULT
            ? ("vault" as const)
            : ("checkout" as const),
      }
    : null;
  const reason = payment
    ? payment.paymentSource === "vault"
      ? null
      : "CHECKOUT_STARTED"
    : await autopayIneligibility(context, user.id, proposal);
  return {
    eligible: payment === null && reason === null,
    reason,
    paymentMethodStatus: profile?.status ?? PaymentProfileStatus.DISCONNECTED,
    payment,
  };
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

export interface ReconcilePaymentOptions {
  /** Age after which an unconfirmed capture on a still-APPROVED order returns to the payer. */
  readonly staleAfterMs?: number;
  readonly now?: Date;
}

/**
 * Checks existing provider records only; never creates an order or a capture.
 * Shared by the customer status check, the admin reconcile action and the
 * payment reconcile worker.
 */
export async function reconcilePaypalOrder(
  context: PaymentServiceContext,
  user: Owner,
  paymentId: string,
  options: ReconcilePaymentOptions = {},
) {
  if (!context.paypal) throw new PaymentServiceError("PAYPAL_UNAVAILABLE");
  const payment = await receiptForUser(context.database, user.id, paymentId);
  if (
    settledPaymentStatuses.includes(payment.status) ||
    terminalUnpaidStatuses.includes(payment.status)
  ) {
    return { payment: paymentDTO(payment), pending: false };
  }
  if (!payment.paypalOrderId) return { payment: paymentDTO(payment), pending: true };
  const now = options.now ?? new Date();
  const stale =
    payment.updatedAt.getTime() <=
    now.getTime() - (options.staleAfterMs ?? CAPTURE_PENDING_STALE_MS);
  try {
    const order = await context.paypal.getOrder(payment.paypalOrderId);
    validateProviderOrder(order, payment, payment.paypalOrderId);
    if (order.status === "COMPLETED") {
      const capture = captureFromOrder(order, payment);
      if (capture) {
        const result = await applyProviderCapture(context, user, payment, capture);
        return {
          payment: paymentDTO(result.payment),
          pending: !settledPaymentStatuses.includes(result.payment.status) && result.pending,
        };
      }
    }
    if (order.status === "VOIDED") {
      const failed = await closeUnpaidPayment(context, user, payment.id, {
        status: PaymentStatus.FAILED,
        failureCode: "PAYPAL_ORDER_VOIDED",
        providerIssue: "ORDER_VOIDED",
        dedupe: "order-voided",
      });
      return { payment: paymentDTO(failed), pending: false };
    }
    if (payment.status === PaymentStatus.CAPTURE_PENDING && stale && !payment.paypalCaptureId) {
      if (order.status === "APPROVED") {
        // PayPal never completed the capture. Keep the request ID so the
        // payer's next attempt is an idempotent replay of the same request.
        const returned = await returnToPayer(context, user, payment.id, {
          status: PaymentStatus.APPROVED,
          reason: "CAPTURE_NOT_CONFIRMED",
          payerActionUrl: null,
          rotateRequestId: false,
          expectedRequestId: payment.paypalCaptureRequestId,
        });
        return { payment: paymentDTO(returned), pending: false };
      }
      if (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED") {
        const returned = await returnToPayer(context, user, payment.id, {
          status: PaymentStatus.CREATED,
          reason: "ORDER_NOT_APPROVED",
          payerActionUrl: payerRedirect(context, order, order.id),
          rotateRequestId: false,
          expectedRequestId: payment.paypalCaptureRequestId,
        });
        return { payment: paymentDTO(returned), pending: false };
      }
    }
    if (order.status === "APPROVED" && payment.status === PaymentStatus.CREATED) {
      const approved = await context.database.$transaction(async (tx) => {
        const current = await lockPaymentInOrder(tx, user.id, payment.id);
        if (current.status !== PaymentStatus.CREATED) return current;
        validateProviderOrder(order, current, current.paypalOrderId);
        // The payer re-approved after an earlier funding-source rejection.
        const reapproval = current.providerStatusReason !== null;
        await tx.auditEvent.create({
          data: {
            userId: user.id,
            eventType: AuditEventType.PAYPAL_ORDER_APPROVED,
            entityType: AuditEntityType.PAYMENT,
            entityId: current.id,
            dedupeKey: reapproval
              ? `paypal-order-reapproved:${current.id}:${current.updatedAt.getTime()}`
              : `paypal-order-approved:${current.id}`,
            payload: { paymentId: current.id, proposalId: current.proposalId },
          },
        });
        return tx.payment.update({
          where: { id: current.id },
          data: {
            status: PaymentStatus.APPROVED,
            providerStatusReason: null,
            payerActionUrl: null,
          },
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
    pending:
      !settledPaymentStatuses.includes(current.status) &&
      !terminalUnpaidStatuses.includes(current.status),
  };
}

export async function getPayment(
  context: PaymentServiceContext,
  user: Owner,
  paymentOrOrderId: string,
) {
  return { payment: paymentDTO(await receiptForUser(context.database, user.id, paymentOrOrderId)) };
}

export interface PayPalEnvironmentInput {
  PAYPAL_ENV?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
}

export function createPayPalClientFromEnvironment(input: PayPalEnvironmentInput) {
  try {
    return new PayPalClient(
      parsePayPalConfig({
        environment: input.PAYPAL_ENV?.trim() || undefined,
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

export function payPalStatusFromEnvironment(input: PayPalEnvironmentInput) {
  const environment = input.PAYPAL_ENV === "live" ? ("live" as const) : ("sandbox" as const);
  return {
    configured:
      (input.PAYPAL_ENV === undefined ||
        input.PAYPAL_ENV === "sandbox" ||
        input.PAYPAL_ENV === "live") &&
      Boolean(input.PAYPAL_CLIENT_ID?.trim()) &&
      Boolean(input.PAYPAL_CLIENT_SECRET?.trim()),
    environment,
    webhookConfigured: Boolean(input.PAYPAL_WEBHOOK_ID?.trim()),
  };
}

export { paymentDTO as serializePayment };
