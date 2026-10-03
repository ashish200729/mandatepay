import type { PaymentRecord, PaymentRefund, PayPalStatus } from "./types";

export class PaymentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaymentApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Payment response is missing ${field}.`);
  return value;
}

function readNullableString(value: unknown, field: string) {
  if (value !== null && typeof value !== "string")
    throw new Error(`Payment response has invalid ${field}.`);
  return value as string | null;
}

function readMinor(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Payment response has invalid ${field}.`);
  return value;
}

function readRefund(value: unknown): PaymentRefund {
  if (!isRecord(value)) throw new Error("Payment response has invalid refunds.");
  if (value.currency !== "USD") throw new Error("Payment response has invalid refund currency.");
  return {
    id: readString(value.id, "refund.id"),
    status: readString(value.status, "refund.status"),
    amount: readMinor(value.amount, "refund.amount"),
    currency: "USD",
    paypalRefundId: readNullableString(value.paypalRefundId, "refund.paypalRefundId"),
  };
}

export function isSafeSandboxApprovalUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "sandbox.paypal.com" || url.hostname === "www.sandbox.paypal.com") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function readPayment(value: unknown): PaymentRecord {
  const candidate = isRecord(value) && isRecord(value.payment) ? value.payment : value;
  if (!isRecord(candidate) || !isRecord(candidate.product) || !isRecord(candidate.mandate))
    throw new Error("Payment response was not valid.");
  const product = candidate.product;
  const mandate = candidate.mandate;
  if (
    (product.condition !== "NEW" &&
      product.condition !== "USED" &&
      product.condition !== "REFURBISHED") ||
    product.brand === undefined ||
    typeof mandate.version !== "number" ||
    !Number.isSafeInteger(mandate.version) ||
    mandate.version < 1
  )
    throw new Error("Payment response was not valid.");
  if (candidate.currency !== "USD") throw new Error("Only USD payments are supported.");
  if (!Array.isArray(candidate.refunds)) throw new Error("Payment response has invalid refunds.");
  return {
    id: readString(candidate.id, "id"),
    proposalId: readString(candidate.proposalId, "proposalId"),
    status: readString(candidate.status, "status"),
    amount: readMinor(candidate.amount, "amount"),
    currency: "USD",
    paypalOrderId: readNullableString(candidate.paypalOrderId, "paypalOrderId"),
    paypalCaptureId: readNullableString(candidate.paypalCaptureId, "paypalCaptureId"),
    capturedAt: readNullableString(candidate.capturedAt, "capturedAt"),
    createdAt: readString(candidate.createdAt, "createdAt"),
    product: {
      title: readString(product.title, "product.title"),
      brand: readString(product.brand, "product.brand"),
      condition: product.condition,
      merchant: readString(product.merchant, "product.merchant"),
    },
    mandate: { title: readString(mandate.title, "mandate.title"), version: mandate.version },
    refunds: candidate.refunds.map(readRefund),
  };
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : "The payment service could not complete that request.";
    throw new PaymentApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

export async function createPaypalOrder(proposalId: string) {
  const payload = await request("/api/paypal/orders", {
    method: "POST",
    body: JSON.stringify({ proposalId }),
  });
  if (
    !isRecord(payload) ||
    (payload.approvalUrl !== null && !isSafeSandboxApprovalUrl(payload.approvalUrl))
  )
    throw new Error("PayPal returned an unsafe approval URL.");
  return {
    payment: readPayment(payload.payment),
    approvalUrl: payload.approvalUrl as string | null,
  };
}

export async function capturePaypalOrder(paymentId: string) {
  return readPayment(
    await request(`/api/paypal/orders/${encodeURIComponent(paymentId)}/capture`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  );
}

export function createRefundRequestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function createRefund(
  paymentId: string,
  input: { amountMinor: number | null; reason: string; requestKey: string },
) {
  const payload = await request(`/api/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST",
    body: JSON.stringify({ ...input, confirmed: true }),
  });
  if (!isRecord(payload) || typeof payload.pending !== "boolean")
    throw new Error("Refund response was not valid.");
  if (!isRecord(payload.refund)) throw new Error("Refund response is missing the refund record.");
  const refund = readRefund(payload.refund);
  return { refund, payment: readPayment(payload.payment), pending: payload.pending };
}

export async function listOrders() {
  const payload = await request("/api/orders");
  if (!isRecord(payload) || !Array.isArray(payload.orders))
    throw new Error("The orders response was not valid.");
  return payload.orders.map(readPayment);
}

export async function getOrder(id: string) {
  return readPayment(await request(`/api/orders/${encodeURIComponent(id)}`));
}

export async function getPaypalStatus(): Promise<PayPalStatus> {
  const payload = await request("/api/paypal/status");
  if (
    !isRecord(payload) ||
    typeof payload.configured !== "boolean" ||
    payload.environment !== "sandbox" ||
    typeof payload.webhookConfigured !== "boolean"
  )
    throw new Error("PayPal status response was not valid.");
  return {
    configured: payload.configured,
    environment: "sandbox",
    webhookConfigured: payload.webhookConfigured,
  };
}
