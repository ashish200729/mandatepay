export type ApprovalProduct = {
  title: string;
  brand: string | null;
  condition: "NEW" | "USED" | "REFURBISHED";
  merchant: string;
  source: "demo" | "channel3";
};

export type ApprovalProposal = {
  id: string;
  status: string;
  total: number;
  currency: "USD";
  quantity: number;
  shipping: number;
  tax: number;
  expiresAt: string | null;
  approvalExpiresAt: string | null;
  product: ApprovalProduct;
  mandate: { title: string; version: number };
};

export type DecisionCheckStatus = "pass" | "approval" | "block";

/** One deterministic AgentGuard rule check, as recorded by the server. */
export type DecisionCheck = {
  rule: string;
  label: string;
  status: DecisionCheckStatus;
  limit: string | null;
  actual: string | null;
  message: string;
};

/** Server-templated, read-only explanation of a recorded AgentGuard decision. */
export type DecisionExplanation = {
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";
  headline: string;
  summary: string;
  approvalCanOverride: boolean;
  checks: DecisionCheck[];
};

export type ApprovalDecision = {
  decision: string;
  reasonCodes: string[];
  explanation?: DecisionExplanation | null;
};

export type ApprovalDetail = {
  proposal: ApprovalProposal;
  decision: ApprovalDecision | null;
};
