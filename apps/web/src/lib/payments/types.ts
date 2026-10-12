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
  /** Issued in PayPal outside MandatePay and recorded from a verified webhook. */
  providerInitiated?: boolean;
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
  /** Server-owned failure code, for example PAYPAL_ORDER_VOIDED. */
  failureCode?: string | null;
  /** Safe PayPal reason code for a held or payer-action state. */
  providerStatusReason?: string | null;
  /** Validated PayPal redirect when the payer must act before payment. */
  payerActionUrl?: string | null;
  /** "vault" when the server paid buyer-not-present with the saved PayPal method. */
  paymentSource?: "checkout" | "vault";
  product: PaymentProduct;
  mandate: PaymentMandate;
  refunds: readonly PaymentRefund[];
};

export type PayPalStatus = {
  configured: boolean;
  environment: "sandbox" | "live";
  webhookConfigured: boolean;
};
