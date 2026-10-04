export type PaymentProduct = {
  title: string;
  brand: string;
  condition: "NEW" | "USED" | "REFURBISHED";
  merchant: string;
};

export type PaymentMandate = { title: string; version: number };

export type PaymentRefund = {
  id: string;
  status: string;
  amount: number;
  currency: "USD";
  paypalRefundId: string | null;
};

export type PaymentRecord = {
  id: string;
  proposalId: string;
  status: string;
  amount: number;
  currency: "USD";
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  capturedAt: string | null;
  createdAt: string;
  authorizationExpiresAt?: string | null;
  product: PaymentProduct;
  mandate: PaymentMandate;
  refunds: readonly PaymentRefund[];
};

export type PayPalStatus = {
  configured: boolean;
  environment: "sandbox";
  webhookConfigured: boolean;
};
