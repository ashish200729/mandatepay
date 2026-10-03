export type DashboardTotals = {
  purchases: number;
  policyAllowed: number;
  humanApproved: number;
  blocked: number;
  spendMinor: number;
  refundsMinor: number;
  activeMandates: number;
};

export type TransactionRow = {
  id: string;
  createdAt: string;
  product: { title: string; brand: string; condition: string };
  merchant: string;
  category: string | null;
  amountMinor: number;
  currency: "USD";
  mandate: { title: string; version: number };
  decision: string | null;
  approvalType: string | null;
  paypalStatus: string | null;
};

export type PolicyEventRow = {
  id: string;
  proposalId: string;
  createdAt: string;
  product: { title: string; merchant: string; category: string | null };
  mandate: { title: string; version: number };
  reasonCodes: string[];
  rulesSnapshot: unknown;
};

export type AuditEvent = {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  payload: Record<string, unknown> | null;
};

export type DashboardFilters = {
  minAmountMinor?: number;
  minAmountExclusive?: boolean;
  maxAmountMinor?: number;
  maxAmountExclusive?: boolean;
  decision?: string;
  category?: string;
  status?: string;
  since?: string;
  until?: string;
};

export type DashboardQueryResult =
  | {
      status: "ready";
      filters: Record<string, unknown>;
      transactions: TransactionRow[];
      nextCursor: string | null;
    }
  | { status: "needs_clarification"; clarification: string; filters: null };
