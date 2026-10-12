import type { ApprovalDecision } from "../approvals/types";

export type ProductSource = "demo" | "channel3";
export type ProductCondition = "NEW" | "USED" | "REFURBISHED";

export type NormalizedProduct = {
  source: ProductSource;
  externalId: string;
  title: string;
  brand: string;
  category: string | null;
  condition: ProductCondition;
  priceMinor: number;
  currency: "USD";
  merchant: string;
  imageUrl: string | null;
  productUrl: string | null;
  checkoutEligible: boolean;
  demoSku: string | null;
};

export type ProductRanking = {
  productId: string;
  rank: number;
  explanation: string;
  tradeoffs: string[];
};

export type PurchaseProposal = {
  id: string;
  status?: string;
  decision?: string;
  reason?: string;
  total?: number;
  currency?: string;
  policyDecision?: string;
  policyReason?: string;
  /** The recorded AgentGuard decision with its read-only explanation, when evaluated. */
  policy?: ApprovalDecision;
};
