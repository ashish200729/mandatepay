import type {
  AuditEvent,
  DashboardFilters,
  DashboardQueryResult,
  DashboardTotals,
  PolicyEventRow,
  TransactionRow,
} from "./types";

export class AnalyticsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AnalyticsApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function string(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Analytics response is missing ${field}.`);
  return value;
}

function integer(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Analytics response has invalid ${field}.`);
  return value;
}

function readTransaction(value: unknown): TransactionRow {
  if (!isRecord(value) || !isRecord(value.product) || !isRecord(value.mandate))
    throw new Error("Transaction response was not valid.");
  return {
    id: string(value.id, "transaction.id"),
    createdAt: string(value.createdAt, "transaction.createdAt"),
    product: {
      title: string(value.product.title, "product.title"),
      brand: string(value.product.brand, "product.brand"),
      condition: string(value.product.condition, "product.condition"),
    },
    merchant: string(value.merchant, "merchant"),
    category: value.category === null ? null : string(value.category, "category"),
    amountMinor: integer(value.amountMinor, "amountMinor"),
    currency:
      value.currency === "USD"
        ? "USD"
        : (() => {
            throw new Error("Only USD analytics are supported.");
          })(),
    mandate: {
      title: string(value.mandate.title, "mandate.title"),
      version: integer(value.mandate.version, "mandate.version"),
    },
    decision: value.decision === null ? null : string(value.decision, "decision"),
    approvalType: value.approvalType === null ? null : string(value.approvalType, "approvalType"),
    paypalStatus: value.paypalStatus === null ? null : string(value.paypalStatus, "paypalStatus"),
  };
}

function readPolicyEvent(value: unknown): PolicyEventRow {
  if (
    !isRecord(value) ||
    !isRecord(value.product) ||
    !isRecord(value.mandate) ||
    !Array.isArray(value.reasonCodes)
  )
    throw new Error("Policy event response was not valid.");
  if (value.reasonCodes.some((code) => typeof code !== "string"))
    throw new Error("Policy event reason codes were not valid.");
  return {
    id: string(value.id, "policy.id"),
    proposalId: string(value.proposalId, "policy.proposalId"),
    createdAt: string(value.createdAt, "policy.createdAt"),
    product: {
      title: string(value.product.title, "policy.product.title"),
      merchant: string(value.product.merchant, "policy.product.merchant"),
      category:
        value.product.category === null
          ? null
          : string(value.product.category, "policy.product.category"),
    },
    mandate: {
      title: string(value.mandate.title, "policy.mandate.title"),
      version: integer(value.mandate.version, "policy.mandate.version"),
    },
    reasonCodes: value.reasonCodes as string[],
    rulesSnapshot: value.rulesSnapshot ?? null,
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
          : "Analytics could not complete that request.";
    throw new AnalyticsApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

export async function getDashboardSummary() {
  const payload = await request("/api/dashboard/summary");
  if (!isRecord(payload) || !isRecord(payload.totals))
    throw new Error("Dashboard summary was not valid.");
  const totals = payload.totals;
  return {
    purchases: integer(totals.purchases, "purchases"),
    policyAllowed: integer(totals.policyAllowed, "policyAllowed"),
    humanApproved: integer(totals.humanApproved, "humanApproved"),
    blocked: integer(totals.blocked, "blocked"),
    spendMinor: integer(totals.spendMinor, "spendMinor"),
    refundsMinor: integer(totals.refundsMinor, "refundsMinor"),
    activeMandates: integer(totals.activeMandates, "activeMandates"),
  } satisfies DashboardTotals;
}

function queryString(filters: DashboardFilters & { limit?: number; cursor?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}

export async function getDashboardTransactions(
  filters: DashboardFilters & { limit?: number; cursor?: string } = {},
) {
  const payload = await request(`/api/dashboard/transactions?${queryString(filters)}`);
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.transactions) ||
    (payload.nextCursor !== null && typeof payload.nextCursor !== "string")
  )
    throw new Error("Dashboard transactions were not valid.");
  return {
    transactions: payload.transactions.map(readTransaction),
    nextCursor: payload.nextCursor as string | null,
  };
}

export async function getPolicyEvents() {
  const payload = await request("/api/dashboard/policy-events");
  if (!isRecord(payload) || !Array.isArray(payload.events))
    throw new Error("Policy events were not valid.");
  return payload.events.map(readPolicyEvent);
}

export async function queryDashboard(query: string): Promise<DashboardQueryResult> {
  const payload = await request("/api/dashboard/query", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (
    !isRecord(payload) ||
    (payload.status !== "ready" && payload.status !== "needs_clarification")
  )
    throw new Error("Dashboard query response was not valid.");
  if (payload.status === "needs_clarification")
    return {
      status: "needs_clarification",
      clarification: string(payload.clarification, "clarification"),
      filters: null,
    };
  if (
    !isRecord(payload.filters) ||
    !Array.isArray(payload.transactions) ||
    (payload.nextCursor !== null && typeof payload.nextCursor !== "string")
  )
    throw new Error("Dashboard query response was not valid.");
  return {
    status: "ready",
    filters: payload.filters,
    transactions: payload.transactions.map(readTransaction),
    nextCursor: payload.nextCursor as string | null,
  };
}

export async function getAuditEvents(entityId: string) {
  const payload = await request(`/api/audit?entityId=${encodeURIComponent(entityId)}`);
  if (!isRecord(payload) || !Array.isArray(payload.events))
    throw new Error("Audit response was not valid.");
  return payload.events.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      typeof event.eventType !== "string" ||
      typeof event.entityType !== "string" ||
      typeof event.entityId !== "string" ||
      typeof event.createdAt !== "string" ||
      (event.payload !== null && !isRecord(event.payload))
    )
      throw new Error("Audit event response was not valid.");
    return event as unknown as AuditEvent;
  });
}
