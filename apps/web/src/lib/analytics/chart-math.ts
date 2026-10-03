import type { TransactionRow } from "./types";

const CAPTURED_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);

export function capturedSpendByCategory(rows: readonly TransactionRow[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.capturedAt || !row.paypalStatus || !CAPTURED_STATUSES.has(row.paypalStatus)) continue;
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
