import type { ApprovalDecision, ApprovalDetail, ApprovalProposal } from "./types";

export class ApprovalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApprovalApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The approval response is missing ${field}.`);
  }
  return value;
}

function readMinor(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The approval response has invalid ${field}.`);
  }
  return value;
}

function readDecision(value: unknown): ApprovalDecision | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.decision !== "string" || !Array.isArray(value.reasonCodes)) {
    throw new Error("The approval decision response was not valid.");
  }
  if (value.reasonCodes.some((code) => typeof code !== "string")) {
    throw new Error("The approval reason codes were not valid.");
  }
  return { decision: value.decision, reasonCodes: value.reasonCodes as string[] };
}

export function readApprovalProposal(value: unknown): ApprovalProposal {
  const candidate = isRecord(value) && isRecord(value.proposal) ? value.proposal : value;
  if (!isRecord(candidate) || !isRecord(candidate.product) || !isRecord(candidate.mandate)) {
    throw new Error("The approval proposal response was not valid.");
  }
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
  ) {
    throw new Error("The approval proposal response was not valid.");
  }
  return {
    id: readString(candidate.id, "id"),
    status: readString(candidate.status, "status"),
    total: readMinor(candidate.total, "total"),
    currency:
      candidate.currency === "USD"
        ? "USD"
        : (() => {
            throw new Error("Only USD approvals are supported.");
          })(),
    quantity:
      typeof candidate.quantity === "number" &&
      Number.isSafeInteger(candidate.quantity) &&
      candidate.quantity > 0
        ? candidate.quantity
        : (() => {
            throw new Error("The approval quantity was not valid.");
          })(),
    shipping: readMinor(candidate.shipping, "shipping"),
    tax: readMinor(candidate.tax, "tax"),
    expiresAt: candidate.expiresAt === null ? null : readString(candidate.expiresAt, "expiresAt"),
    approvalExpiresAt:
      candidate.approvalExpiresAt === null && candidate.status !== "AWAITING_APPROVAL"
        ? null
        : readString(candidate.approvalExpiresAt, "approvalExpiresAt"),
    product: {
      title: readString(product.title, "product.title"),
      brand: product.brand === null ? null : readString(product.brand, "product.brand"),
      condition: product.condition,
      merchant: readString(product.merchant, "product.merchant"),
      source: product.source,
    },
    mandate: { title: readString(mandate.title, "mandate.title"), version: mandate.version },
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
          : "The approvals service could not complete that request.";
    throw new ApprovalApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

export async function listApprovals() {
  const payload = await request("/api/approvals");
  if (!isRecord(payload) || !Array.isArray(payload.proposals))
    throw new Error("The approval list response was not valid.");
  return payload.proposals.map(readApprovalProposal);
}

export async function getApproval(id: string): Promise<ApprovalDetail> {
  const payload = await request(`/api/proposals/${encodeURIComponent(id)}`);
  if (!isRecord(payload)) throw new Error("The approval response was not valid.");
  return {
    proposal: readApprovalProposal(payload.proposal),
    decision: readDecision(payload.decision),
  };
}

export async function decideApproval(id: string, decision: "approve" | "reject") {
  const payload = await request(`/api/proposals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!isRecord(payload)) throw new Error("The approval decision response was not valid.");
  return {
    proposal: readApprovalProposal(payload.proposal),
    decision: readDecision(payload.decision),
  };
}
