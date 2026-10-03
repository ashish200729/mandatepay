export type ApprovalProduct = {
  title: string;
  brand: string;
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
  expiresAt: string;
  approvalExpiresAt: string | null;
  product: ApprovalProduct;
  mandate: { title: string; version: number };
};

export type ApprovalDecision = {
  decision: string;
  reasonCodes: string[];
};

export type ApprovalDetail = {
  proposal: ApprovalProposal;
  decision: ApprovalDecision | null;
};
