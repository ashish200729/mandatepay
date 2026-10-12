import { readDecisionExplanation } from "../approvals/reasons";
import type {
  AgentLiveStep,
  AgentProposal,
  AgentStep,
  ExcludedProduct,
  RefundDraft,
  ShoppingAgentResponse,
} from "./types";
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
      explanation: readDecisionExplanation(decisionValue.explanation),
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

/** Only same-origin Demo Catalog illustrations are rendered; anything else is dropped. */
export function safeProductImage(value: unknown): string | null {
  return typeof value === "string" && /^\/demo-products\/[a-z0-9-]{1,80}\.svg$/u.test(value)
    ? value
    : null;
}

/** Excluded listings are informational. Malformed entries are skipped rather than trusted. */
export function readExcludedProducts(value: unknown): ExcludedProduct[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry): ExcludedProduct[] => {
    if (
      !isRecord(entry) ||
      (entry.source !== "demo" && entry.source !== "channel3") ||
      typeof entry.externalId !== "string" ||
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      (entry.brand !== null && typeof entry.brand !== "string") ||
      (entry.condition !== "NEW" &&
        entry.condition !== "USED" &&
        entry.condition !== "REFURBISHED") ||
      typeof entry.priceMinor !== "number" ||
      !Number.isSafeInteger(entry.priceMinor) ||
      entry.priceMinor < 0 ||
      typeof entry.merchant !== "string" ||
      !Array.isArray(entry.reasons)
    )
      return [];
    const reasons = entry.reasons
      .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
      .slice(0, 8)
      .map((reason) => reason.slice(0, 300));
    if (!reasons.length) return [];
    return [
      {
        externalId: entry.externalId,
        source: entry.source,
        title: entry.title.slice(0, 300),
        brand: entry.brand as string | null,
        condition: entry.condition,
        priceMinor: entry.priceMinor,
        merchant: entry.merchant.slice(0, 200),
        imageUrl: safeProductImage(entry.imageUrl),
        reasons,
        promptInjection: entry.promptInjection === true,
      },
    ];
  });
}

const STEP_LABELS: Record<string, string> = {
  get_active_mandates: "Read your active mandate",
  search_products: "Searched the catalog",
  get_product_details: "Checked product details",
  compare_products: "Compared products",
  create_purchase_proposal: "Prepared a proposal and ran AgentGuard",
  find_transaction: "Looked up your purchases",
  prepare_refund_request: "Prepared a refund request",
  check_checkout_availability: "Checked checkout eligibility",
};

/** Human-readable label for a server step; unknown names are humanized, not shown raw. */
export function agentStepLabel(name: string) {
  const known = STEP_LABELS[name];
  if (known) return known;
  const words = name.replace(/[_-]+/gu, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Server step";
}

// Leave time for the server's overall budget and the proxy's error response.
const CHAT_DEADLINE_MS = 135_000;
const TIMEOUT_MESSAGE =
  "The shopping assistant took too long to respond. Retry the same request in a moment.";
const CONNECTION_MESSAGE =
  "We couldn’t connect to the shopping assistant. Check your connection, then retry the same request.";

function apiError(payload: Record<string, unknown> | null, status: number) {
  const message =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : "The shopping agent could not complete that request.";
  return new ShoppingAgentApiError(
    message.slice(0, 240),
    status,
    typeof payload?.code === "string" ? payload.code : undefined,
  );
}

async function request(path: string, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_DEADLINE_MS);
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw apiError(payload, response.status);
    return payload;
  } catch (cause) {
    if (controller.signal.aborted) throw new ShoppingAgentApiError(TIMEOUT_MESSAGE, 504);
    if (cause instanceof TypeError) throw new ShoppingAgentApiError(CONNECTION_MESSAGE, 503);
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

function chatBody(
  message: string,
  mandateId: string | undefined,
  requestKey: string,
  productContext?: string,
) {
  return {
    message,
    ...(mandateId?.trim() ? { mandateId } : {}),
    requestKey,
    ...(productContext ? { productContext } : {}),
  };
}

export async function sendShoppingMessage(
  message: string,
  mandateId: string | undefined,
  requestKey: string,
  productContext?: string,
): Promise<ShoppingAgentResponse> {
  return readShoppingResponse(
    await request("/api/agent/chat", chatBody(message, mandateId, requestKey, productContext)),
  );
}

/** Validates a chat payload from either endpoint; anything malformed is rejected. */
export function readShoppingResponse(payload: unknown): ShoppingAgentResponse {
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
    excludedProducts: readExcludedProducts(payload.excludedProducts),
    ...(payload.productContext !== undefined
      ? { productContext: payload.productContext as string | null }
      : {}),
  };
}

const LIVE_STEP_STATUSES = new Set(["running", "completed", "blocked", "failed"]);

/** Accepts only well-formed, server-templated progress steps. */
export function readAgentLiveStep(value: unknown): AgentLiveStep | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9_-]{0,39}$/u.test(value.id) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    typeof value.status !== "string" ||
    !LIVE_STEP_STATUSES.has(value.status)
  )
    return null;
  return {
    id: value.id,
    label: value.label.slice(0, 120),
    status: value.status as AgentLiveStep["status"],
  };
}

export type ChatStreamEvent = { event: string; data: string };

/**
 * Incremental Server-Sent Events reader: feed decoded text chunks in any split
 * and receive each complete `event`/`data` frame. Comment lines are ignored.
 */
export function createChatStreamParser(onEvent: (event: ChatStreamEvent) => void) {
  let buffer = "";
  const flushFrame = (frame: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) onEvent({ event, data: data.join("\n") });
  };
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n?/gu, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        flushFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      // A single frame never needs more than this; drop runaway input instead of growing.
      if (buffer.length > 1_000_000) buffer = "";
    },
    end() {
      if (buffer.trim()) flushFrame(buffer);
      buffer = "";
    },
  };
}

const INTERRUPTED_MESSAGE =
  "The connection to the shopping assistant was interrupted. Retry the same request.";

type StreamOutcome = { response: ShoppingAgentResponse } | { error: ShoppingAgentApiError };

/**
 * Sends a chat message over the streaming endpoint, reporting live steps.
 * If streaming fails before any event arrives (network error, missing route
 * or an empty stream), it falls back to the JSON endpoint with the same
 * request key, so the server's idempotency still applies.
 */
export async function streamShoppingMessage(
  message: string,
  mandateId: string | undefined,
  requestKey: string,
  productContext: string | undefined,
  onStep: (step: AgentLiveStep) => void,
): Promise<ShoppingAgentResponse> {
  const body = chatBody(message, mandateId, requestKey, productContext);
  const fallback = () => sendShoppingMessage(message, mandateId, requestKey, productContext);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_DEADLINE_MS);
  let sawEvent = false;
  try {
    let response: Response;
    try {
      response = await fetch("/api/agent/chat/stream", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new ShoppingAgentApiError(TIMEOUT_MESSAGE, 504);
      return await fallback();
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream") || !response.body) {
      if (response.status === 404 || response.status === 405) return await fallback();
      // Checks that fail before the run (and proxy errors) answer with ordinary JSON.
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) throw apiError(payload, response.status);
      if (payload === null) return await fallback();
      return readShoppingResponse(payload);
    }
    let outcome: StreamOutcome | null = null;
    const parser = createChatStreamParser(({ event, data }) => {
      if (outcome) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (event === "step") {
        const step = readAgentLiveStep(parsed);
        if (!step) return;
        sawEvent = true;
        onStep(step);
      } else if (event === "result") {
        sawEvent = true;
        try {
          outcome = { response: readShoppingResponse(parsed) };
        } catch {
          outcome = {
            error: new ShoppingAgentApiError(
              "The shopping agent response was not valid.",
              502,
              "SHOPPING_AI_RESPONSE_INVALID",
            ),
          };
        }
      } else if (event === "error") {
        sawEvent = true;
        const payload = isRecord(parsed) ? parsed : null;
        const status =
          typeof payload?.status === "number" && payload.status >= 400 && payload.status < 600
            ? payload.status
            : 503;
        outcome = { error: apiError(payload, status) };
      }
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!outcome) {
        const chunk = await reader.read();
        if (chunk.done) {
          parser.push(decoder.decode());
          parser.end();
          break;
        }
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      if (controller.signal.aborted) throw new ShoppingAgentApiError(TIMEOUT_MESSAGE, 504);
      if (!sawEvent) return await fallback();
      throw new ShoppingAgentApiError(INTERRUPTED_MESSAGE, 503, "SHOPPING_STREAM_INTERRUPTED");
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const settled = outcome as StreamOutcome | null;
    if (settled && "response" in settled) return settled.response;
    if (settled) throw settled.error;
    if (!sawEvent) return await fallback();
    throw new ShoppingAgentApiError(INTERRUPTED_MESSAGE, 503, "SHOPPING_STREAM_INTERRUPTED");
  } finally {
    clearTimeout(timer);
  }
}
