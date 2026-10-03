import type { AgentProposal, AgentStep, RefundDraft, ShoppingAgentResponse } from "./types";
import { readRefundDraft } from "./refund-draft";

export class ShoppingAgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ShoppingAgentApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function string(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Agent response is missing ${field}.`);
  return value;
}

function minor(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Agent response has invalid ${field}.`);
  return value;
}

function nullableString(value: unknown, field: string) {
  if (value !== null && typeof value !== "string")
    throw new Error(`Agent response has invalid ${field}.`);
  return value as string | null;
}

function readProposal(value: unknown): AgentProposal {
  const wrapper = isRecord(value) && isRecord(value.proposal) ? value : null;
  const candidate = wrapper && isRecord(wrapper.proposal) ? wrapper.proposal : value;
  if (!isRecord(candidate) || !isRecord(candidate.product) || !isRecord(candidate.mandate))
    throw new Error("Agent proposal response was not valid.");
  const product = candidate.product;
  const mandate = candidate.mandate;
  if (
    (product.source !== "demo" && product.source !== "channel3") ||
    (product.condition !== "NEW" &&
      product.condition !== "USED" &&
      product.condition !== "REFURBISHED") ||
    typeof mandate.version !== "number" ||
    !Number.isSafeInteger(mandate.version) ||
    mandate.version < 1
  )
    throw new Error("Agent proposal response was not valid.");
  const decisionValue = wrapper?.decision;
  let decision: AgentProposal["decision"] = null;
  if (decisionValue !== null && decisionValue !== undefined) {
    if (
      !isRecord(decisionValue) ||
      (decisionValue.decision !== "ALLOW" &&
        decisionValue.decision !== "REQUIRE_APPROVAL" &&
        decisionValue.decision !== "BLOCK") ||
      !Array.isArray(decisionValue.reasonCodes) ||
      decisionValue.reasonCodes.some((code) => typeof code !== "string")
    )
      throw new Error("Agent proposal decision was not valid.");
    decision = {
      decision: decisionValue.decision,
      reasonCodes: decisionValue.reasonCodes as string[],
    };
  }
  return {
    id: string(candidate.id, "proposal.id"),
    status: string(candidate.status, "proposal.status"),
    total: minor(candidate.total, "proposal.total"),
    shipping: minor(candidate.shipping, "proposal.shipping"),
    tax: minor(candidate.tax, "proposal.tax"),
    currency:
      candidate.currency === "USD"
        ? "USD"
        : (() => {
            throw new Error("Only USD agent proposals are supported.");
          })(),
    expiresAt: nullableString(candidate.expiresAt, "proposal.expiresAt"),
    approvalExpiresAt: nullableString(candidate.approvalExpiresAt, "proposal.approvalExpiresAt"),
    product: {
      title: string(product.title, "product.title"),
      brand: nullableString(product.brand, "product.brand"),
      condition: product.condition,
      merchant: string(product.merchant, "product.merchant"),
      source: product.source,
    },
    mandate: { title: string(mandate.title, "mandate.title"), version: mandate.version },
    decision,
  };
}

async function request(path: string, body: unknown) {
  const controller = new AbortController();
  // Leave time for the server's overall budget and the proxy's error response.
  const timer = setTimeout(() => controller.abort(), 135_000);
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : "The shopping agent could not complete that request.";
      throw new ShoppingAgentApiError(
        message.slice(0, 240),
        response.status,
        typeof payload?.code === "string" ? payload.code : undefined,
      );
    }
    return payload;
  } catch (cause) {
    if (controller.signal.aborted)
      throw new ShoppingAgentApiError(
        "The shopping assistant took too long to respond. Retry the same request in a moment.",
        504,
      );
    if (cause instanceof TypeError)
      throw new ShoppingAgentApiError(
        "We couldn’t connect to the shopping assistant. Check your connection, then retry the same request.",
        503,
      );
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export function createShoppingRequestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `shopping-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function sendShoppingMessage(
  message: string,
  mandateId: string | undefined,
  requestKey: string,
  productContext?: string,
): Promise<ShoppingAgentResponse> {
  const payload = await request("/api/agent/chat", {
    message,
    ...(mandateId?.trim() ? { mandateId } : {}),
    requestKey,
    ...(productContext ? { productContext } : {}),
  });
  if (
    !isRecord(payload) ||
    typeof payload.message !== "string" ||
    (payload.explanation !== null && !isRecord(payload.explanation)) ||
    !Array.isArray(payload.proposals) ||
    (payload.refundDraft !== null && !isRecord(payload.refundDraft)) ||
    !Array.isArray(payload.steps)
  )
    throw new Error("The shopping agent response was not valid.");
  const steps = payload.steps.map((step) => {
    if (!isRecord(step) || typeof step.name !== "string" || step.status !== "completed")
      throw new Error("The shopping agent steps were not valid.");
    return step as unknown as AgentStep;
  });
  if (
    payload.productContext !== undefined &&
    payload.productContext !== null &&
    (typeof payload.productContext !== "string" || payload.productContext.length > 50_000)
  )
    throw new Error("The shopping product reference was not valid.");
  let explanation: ShoppingAgentResponse["explanation"] = null;
  if (payload.explanation !== null) {
    if (
      payload.explanation.paymentAuthoritative !== false ||
      typeof payload.explanation.text !== "string"
    )
      throw new Error("The shopping agent explanation was not valid.");
    explanation = { text: payload.explanation.text, paymentAuthoritative: false };
  }
  let refundDraft: RefundDraft | null = null;
  if (payload.refundDraft !== null) {
    refundDraft = readRefundDraft(payload.refundDraft);
  }
  return {
    message: payload.message,
    explanation,
    proposals: payload.proposals.map(readProposal),
    refundDraft,
    steps,
    ...(payload.productContext !== undefined
      ? { productContext: payload.productContext as string | null }
      : {}),
  };
}
