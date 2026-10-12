import type { PaymentRecord } from "./types";

export type OrderStatusTone = "neutral" | "success" | "attention" | "danger";

export type OrderStatusPresentation = {
  label: string;
  tone: OrderStatusTone;
  /** One plain sentence for statuses that need more than a label. */
  note: string | null;
};

const LABELS: Record<string, string> = {
  CREATED: "Awaiting PayPal",
  APPROVED: "Approved in PayPal",
  CAPTURE_PENDING: "Payment pending",
  COMPLETED: "Paid",
  DENIED: "Denied by PayPal",
  FAILED: "Payment failed",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  REVERSED: "Reversed by PayPal",
};

function fallbackLabel(status: string) {
  const text = status.replaceAll("_", " ").toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

/** Readable label for a server payment status, used for list badges and filters. */
export function orderStatusLabel(status: string) {
  return LABELS[status] ?? fallbackLabel(status);
}

/**
 * Badge copy for an order. A refund issued in the PayPal dashboard (recorded
 * from a verified webhook) is labelled as such, and a reversal (chargeback)
 * says that PayPal returned the payment.
 */
export function orderStatusPresentation(
  order: Pick<PaymentRecord, "status" | "refunds">,
): OrderStatusPresentation {
  const completed = order.refunds.filter((refund) => refund.status === "COMPLETED");
  const allInPayPal = completed.length > 0 && completed.every((refund) => refund.providerInitiated);
  switch (order.status) {
    case "REVERSED":
      return {
        label: LABELS.REVERSED!,
        tone: "danger",
        note: "PayPal reversed this payment, for example after a dispute or chargeback.",
      };
    case "REFUNDED":
      return {
        label: allInPayPal ? "Refunded in PayPal" : LABELS.REFUNDED!,
        tone: "neutral",
        note: allInPayPal ? "The refund was issued in PayPal, outside MandatePay." : null,
      };
    case "PARTIALLY_REFUNDED":
      return {
        label: allInPayPal ? "Partially refunded in PayPal" : LABELS.PARTIALLY_REFUNDED!,
        tone: "neutral",
        note: allInPayPal ? "The refund was issued in PayPal, outside MandatePay." : null,
      };
    case "COMPLETED":
      return { label: LABELS.COMPLETED!, tone: "success", note: null };
    case "DENIED":
    case "FAILED":
      return { label: orderStatusLabel(order.status), tone: "danger", note: null };
    case "CREATED":
    case "APPROVED":
    case "CAPTURE_PENDING":
      return { label: orderStatusLabel(order.status), tone: "attention", note: null };
    default:
      return { label: orderStatusLabel(order.status), tone: "neutral", note: null };
  }
}
