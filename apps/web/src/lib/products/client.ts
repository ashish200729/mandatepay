import type { NormalizedProduct, ProductRanking, PurchaseProposal } from "./types";
import { approvalReasonText } from "../approvals/reasons";

export class ProductApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
          : "The product service could not complete that request.";
    throw new ProductApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

function readProduct(value: unknown): NormalizedProduct {
  if (!isRecord(value)) throw new Error("The product response was not valid.");
  const source = value.source;
  const condition = value.condition;
  if (
    (source !== "demo" && source !== "channel3") ||
    typeof value.externalId !== "string" ||
    value.externalId.trim().length === 0 ||
    typeof value.title !== "string" ||
    value.title.trim().length === 0 ||
    typeof value.brand !== "string" ||
    value.brand.trim().length === 0 ||
    (value.category !== null &&
      (typeof value.category !== "string" || value.category.trim().length === 0)) ||
    (condition !== "NEW" && condition !== "USED" && condition !== "REFURBISHED") ||
    typeof value.priceMinor !== "number" ||
    !Number.isSafeInteger(value.priceMinor) ||
    value.priceMinor < 0 ||
    value.currency !== "USD" ||
    typeof value.merchant !== "string" ||
    value.merchant.trim().length === 0 ||
    (value.imageUrl !== null &&
      (typeof value.imageUrl !== "string" || value.imageUrl.trim().length === 0)) ||
    (value.productUrl !== null &&
      (typeof value.productUrl !== "string" || value.productUrl.trim().length === 0)) ||
    typeof value.checkoutEligible !== "boolean" ||
    (value.demoSku !== null && typeof value.demoSku !== "string")
  ) {
    throw new Error("The product response was not valid.");
  }

  if (source === "channel3" && (value.checkoutEligible || value.demoSku !== null)) {
    throw new Error("External products cannot be checkout eligible.");
  }
  if (source === "demo" && (!value.checkoutEligible || value.demoSku === null)) {
    throw new Error("Demo products require checkout mapping.");
  }

  return {
    source,
    externalId: value.externalId,
    title: value.title,
    brand: value.brand,
    category: value.category,
    condition,
    priceMinor: value.priceMinor,
    currency: "USD",
    merchant: value.merchant,
    imageUrl: value.imageUrl,
    productUrl: value.productUrl,
    checkoutEligible: value.checkoutEligible,
    demoSku: value.demoSku,
  };
}

function readProposal(value: unknown): PurchaseProposal {
  const candidate = isRecord(value) && isRecord(value.proposal) ? value.proposal : value;
  if (!isRecord(candidate) || typeof candidate.id !== "string") {
    throw new Error("The proposal response was not valid.");
  }
  const policy = isRecord(value) && isRecord(value.decision) ? value.decision : null;
  const decision = policy && typeof policy.decision === "string" ? policy.decision : undefined;
  const codes =
    policy &&
    Array.isArray(policy.reasonCodes) &&
    policy.reasonCodes.every((code) => typeof code === "string")
      ? (policy.reasonCodes as string[])
      : [];
  const reason =
    decision === "REQUIRE_APPROVAL"
      ? approvalReasonText({ decision, reasonCodes: codes })
      : decision === "ALLOW"
        ? "AgentGuard verified the permissions and reserved the amount. No payment has been made."
        : decision === "BLOCK"
          ? `AgentGuard blocked this proposal: ${codes.join(", ") || "the mandate rules were not satisfied"}.`
          : undefined;
  return {
    id: candidate.id,
    status: typeof candidate.status === "string" ? candidate.status : undefined,
    decision,
    reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
    total: typeof candidate.total === "number" ? candidate.total : undefined,
    currency: typeof candidate.currency === "string" ? candidate.currency : undefined,
    policyDecision:
      typeof candidate.policyDecision === "string" ? candidate.policyDecision : undefined,
    policyReason: reason,
  };
}

export async function searchProducts(mandateId: string, query: string) {
  const payload = await request("/api/products/search", {
    method: "POST",
    body: JSON.stringify({ mandateId, ...(query.trim() ? { query: query.trim() } : {}) }),
  });
  if (!isRecord(payload) || !Array.isArray(payload.products)) {
    throw new Error("The product search response was not valid.");
  }
  const mode: "demo" | "channel3" | null =
    payload.mode === "channel3" || payload.mode === "demo" ? payload.mode : null;
  if (!mode || (payload.notice !== null && typeof payload.notice !== "string")) {
    throw new Error("The product search response was not valid.");
  }
  return {
    products: payload.products.map(readProduct),
    mode,
    notice: payload.notice as string | null,
  };
}

export async function compareProducts(mandateId: string, products: NormalizedProduct[]) {
  const payload = await request("/api/products/compare", {
    method: "POST",
    body: JSON.stringify({
      mandateId,
      products: products
        .slice(0, 3)
        .map((product) => ({ source: product.source, externalId: product.externalId })),
    }),
  });
  const ranking = isRecord(payload) && isRecord(payload.ranking) ? payload.ranking : null;
  const recommendations = ranking?.recommendations;
  if (!Array.isArray(recommendations)) throw new Error("The comparison response was not valid.");
  return recommendations.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.productId !== "string" ||
      typeof item.rank !== "number" ||
      typeof item.explanation !== "string" ||
      !Array.isArray(item.tradeoffs) ||
      item.tradeoffs.some((tradeoff) => typeof tradeoff !== "string")
    ) {
      throw new Error("The comparison response was not valid.");
    }
    return item as unknown as ProductRanking;
  });
}

export function createProposalRequestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `proposal-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function createProposal(
  mandateId: string,
  product: NormalizedProduct,
  requestKey = createProposalRequestKey(),
) {
  if (product.source !== "demo") {
    throw new Error("Only demo catalog products can create a proposal in this phase.");
  }
  return readProposal(
    await request("/api/proposals", {
      method: "POST",
      body: JSON.stringify({
        mandateId,
        source: product.source,
        productId: product.externalId,
        quantity: 1,
        requestKey,
      }),
    }),
  );
}

export async function evaluateProposal(id: string) {
  return readProposal(
    await request(`/api/proposals/${encodeURIComponent(id)}/evaluate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  );
}

export function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
