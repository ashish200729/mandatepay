import type { PaymentRecord } from "./types";

export type PaymentOutcomeNotice = {
  readonly tone: "info" | "error";
  readonly message: string;
  /** Validated PayPal redirect for the payer, when PayPal needs their action. */
  readonly actionUrl: string | null;
  readonly actionLabel: string | null;
  /** True when the payer must act in PayPal before a capture can succeed. */
  readonly payerActionRequired: boolean;
};

const PAYER_ACTION_REASONS = new Set(["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED"]);

function notice(
  tone: PaymentOutcomeNotice["tone"],
  message: string,
  options: Partial<Omit<PaymentOutcomeNotice, "tone" | "message">> = {},
): PaymentOutcomeNotice {
  return {
    tone,
    message,
    actionUrl: options.actionUrl ?? null,
    actionLabel: options.actionLabel ?? null,
    payerActionRequired: options.payerActionRequired ?? false,
  };
}

/**
 * Safe, user-facing explanation of a server-recorded payment outcome. Messages
 * use only server-owned status and reason codes, never provider free text.
 */
export function paymentOutcomeNotice(payment: PaymentRecord): PaymentOutcomeNotice | null {
  const reason = payment.providerStatusReason ?? null;
  const failure = payment.failureCode ?? null;
  const actionUrl = payment.payerActionUrl ?? null;

  if (payment.status === "APPROVED" && reason && PAYER_ACTION_REASONS.has(reason)) {
    return notice(
      "error",
      "PayPal could not charge the selected payment method. No money was taken. Choose another payment method in PayPal, then return here to complete payment.",
      {
        actionUrl,
        actionLabel: actionUrl ? "Choose another payment method" : null,
        payerActionRequired: true,
      },
    );
  }
  if (payment.status === "CREATED" && reason === "ORDER_NOT_APPROVED") {
    return notice(
      "error",
      "PayPal has not approved this order yet. No money was taken. Approve it in PayPal, then return here to complete payment.",
      {
        actionUrl,
        actionLabel: actionUrl ? "Approve in PayPal" : null,
        payerActionRequired: true,
      },
    );
  }
  if (payment.status === "APPROVED" && reason === "CAPTURE_NOT_CONFIRMED") {
    return notice(
      "info",
      "PayPal did not confirm the earlier payment attempt and no payment was recorded. Retrying repeats the same request, so you cannot be charged twice.",
    );
  }
  if (payment.status === "CAPTURE_PENDING" && reason) {
    return notice(
      "info",
      `PayPal accepted this payment but is holding it (${reason.replaceAll("_", " ").toLowerCase()}). The spending hold stays in place until PayPal confirms the outcome.`,
    );
  }
  if (payment.status === "FAILED") {
    if (failure === "PAYPAL_ORDER_VOIDED") {
      return notice(
        "error",
        "PayPal voided this order. No money was taken and the spending hold was released. Start a new proposal to buy again.",
      );
    }
    return notice(
      "error",
      "PayPal declined this payment. No money was taken and the spending hold was released. Start a new proposal to try again.",
    );
  }
  if (payment.status === "DENIED") {
    return notice(
      "error",
      "PayPal denied this payment. No money was taken and the spending hold was released.",
    );
  }
  if (payment.status === "REVERSED") {
    return notice(
      "error",
      "PayPal reversed this payment, for example after a dispute or chargeback. Refunds are no longer available for it.",
    );
  }
  return null;
}
