export const PRODUCT_CONDITIONS = ["NEW", "USED", "REFURBISHED"] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

export type CanonicalMandate = {
  title: string;
  productIntent: string;
  currency: "USD";
  timezone: "UTC";
  allowedBrands: string[];
  blockedBrands: string[];
  allowedCategories: string[];
  blockedCategories: string[];
  allowedConditions: ProductCondition[];
  autoSpendLimit: number;
  transactionLimit: number;
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  quantityLimit: number;
  allowedMerchants: string[];
  blockedMerchants: string[];
  newMerchantRequiresApproval: boolean;
  startsAt?: string;
  expiresAt?: string;
};

export type MandateParseResult =
  | {
      status: "ready";
      sourceOriginalPrompt: string;
      mandate: CanonicalMandate;
    }
  | {
      status: "needs_clarification";
      sourceOriginalPrompt: string;
      clarification: string;
      mandate: null;
    };

export type MandateStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "EXPIRED" | "REVOKED";

export type MandateDetail = {
  id: string;
  title: string;
  status: MandateStatus | string;
  version: number;
  originalPrompt: string;
  rules: CanonicalMandate;
  createdAt?: string;
  updatedAt?: string;
  startsAt?: string;
  expiresAt?: string;
};

export type MandateFormState = {
  title: string;
  productIntent: string;
  allowedBrands: string;
  blockedBrands: string;
  allowedCategories: string;
  blockedCategories: string;
  allowedConditions: ProductCondition[];
  autoSpendLimit: string;
  transactionLimit: string;
  dailyLimit: string;
  weeklyLimit: string;
  monthlyLimit: string;
  quantityLimit: string;
  allowedMerchants: string;
  blockedMerchants: string;
  newMerchantRequiresApproval: boolean;
  startsAt: string;
  expiresAt: string;
};

export type MandateAction = "activate" | "pause" | "resume" | "revoke";
