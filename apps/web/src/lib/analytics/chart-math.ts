import type { TransactionRow } from "./types";

/**
 * Payments that were captured, including ones later refunded or reversed by
 * PayPal (a chargeback). Charts of captured spend show this gross volume.
 */
export const CAPTURED_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "REVERSED",
]);

export function isCapturedRow(row: Pick<TransactionRow, "capturedAt" | "paypalStatus">) {
  return Boolean(
    row.capturedAt && row.paypalStatus && CAPTURED_PAYMENT_STATUSES.has(row.paypalStatus),
  );
}

/** How money came back to the customer, if it did. */
export function refundStatusLabel(value: string | null) {
  if (value === "REFUNDED") return "Refunded";
  if (value === "PARTIALLY_REFUNDED") return "Partial refund";
  if (value === "REVERSED") return "Reversed by PayPal";
  return "—";
}

export function paymentStatusLabel(value: string | null) {
  if (!value) return "Not recorded";
  if (value === "REVERSED") return "Reversed by PayPal";
  return value.replaceAll("_", " ");
}

export function capturedSpendByCategory(rows: readonly TransactionRow[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!isCapturedRow(row)) continue;
    const category = row.category ?? "Uncategorized";
    totals.set(category, (totals.get(category) ?? 0) + row.amountMinor);
  }
  return [...totals.entries()]
    .map(([label, amountMinor]) => ({ label, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

export function decisionCounts(rows: readonly TransactionRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const decision = row.decision ?? "UNDECIDED";
    counts.set(decision, (counts.get(decision) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}
