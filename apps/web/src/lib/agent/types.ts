import type { ApprovalProduct } from "@/lib/approvals/types";

export type AgentStep = { name: string; status: "completed" };

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
  decision: { decision: "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK"; reasonCodes: string[] } | null;
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
  productContext?: string | null;
};
