import type { ApprovalProduct, DecisionExplanation } from "../approvals/types";

export type AgentStep = { name: string; status: "completed" };

export type AgentLiveStepStatus = "running" | "completed" | "blocked" | "failed";

/** One live progress step streamed while the agent works. Labels are server-templated. */
export type AgentLiveStep = { id: string; label: string; status: AgentLiveStepStatus };

export type AgentProposal = {
  id: string;
  status: string;
  total: number;
  shipping: number;
  tax: number;
  currency: "USD";
  expiresAt: string | null;
  approvalExpiresAt: string | null;
  product: Omit<ApprovalProduct, "brand"> & { brand: string | null };
  mandate: { title: string; version: number };
  decision: {
    decision: "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";
    reasonCodes: string[];
    explanation: DecisionExplanation | null;
  } | null;
};

/** A retrieved listing the mandate excludes. Shown for transparency; never purchasable here. */
export type ExcludedProduct = {
  externalId: string;
  source: "demo" | "channel3";
  title: string;
  brand: string | null;
  condition: "NEW" | "USED" | "REFURBISHED";
  priceMinor: number;
  merchant: string;
  imageUrl: string | null;
  reasons: string[];
  /** The listing's own text tried to instruct AI agents. */
  promptInjection: boolean;
};

export type RefundDraft = {
  paymentId: string;
  amountMinor: number | null;
  reason: string;
  reviewUrl: string;
};

export type ShoppingAgentResponse = {
  message: string;
  explanation: { text: string; paymentAuthoritative: false } | null;
  proposals: AgentProposal[];
  refundDraft: RefundDraft | null;
  steps: AgentStep[];
  excludedProducts: ExcludedProduct[];
  productContext?: string | null;
};
