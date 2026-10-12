import { explainDecision, type DecisionExplanation } from "@mandatepay/agentguard";
import { CanonicalMandateSchema, POLICY_DECISIONS } from "@mandatepay/shared";

/** The stored policy-decision columns an explanation reads. */
export interface StoredDecisionFacts {
  readonly decision: string;
  readonly reasonCodes: unknown;
  readonly rulesSnapshot?: unknown;
  readonly spendSnapshot?: unknown;
}

/** The immutable proposal facts the decision was recorded against. */
export interface StoredProposalFacts {
  readonly total: bigint | number;
  readonly currency: string;
  readonly quantity: number;
  readonly productSnapshot?: {
    readonly brand: string | null;
    readonly category: string | null;
    readonly condition: string;
    readonly merchant: string;
  } | null;
  readonly mandateVersion?: { readonly version: number } | null;
}

type Window = "daily" | "weekly" | "monthly";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMinor(value: unknown): number | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Confirmed spend plus other active reservations, exactly as AgentGuard summed them. */
function committedSpend(snapshot: unknown): Record<Window, number> | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.confirmed)) return null;
  const totals: Record<Window, number> = { daily: 0, weekly: 0, monthly: 0 };
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const confirmed = safeMinor(snapshot.confirmed[window]);
    if (confirmed === null) return null;
    totals[window] = confirmed;
  }
  const reservations = Array.isArray(snapshot.otherReservations) ? snapshot.otherReservations : [];
  for (const reservation of reservations) {
    if (!isRecord(reservation) || !Array.isArray(reservation.windows)) return null;
    const amount = safeMinor(reservation.amount);
    if (amount === null) return null;
    for (const window of reservation.windows) {
      const key =
        window === "DAILY"
          ? "daily"
          : window === "WEEKLY"
            ? "weekly"
            : window === "MONTHLY"
              ? "monthly"
              : null;
      if (!key) return null;
      totals[key] += amount;
      if (!Number.isSafeInteger(totals[key])) return null;
    }
  }
  return totals;
}

function isPolicyDecision(value: string): value is (typeof POLICY_DECISIONS)[number] {
  return (POLICY_DECISIONS as readonly string[]).includes(value);
}

/**
 * Read-only explanation of a stored AgentGuard decision. It never changes the
 * recorded verdict; malformed historical snapshots fall back to code-only copy.
 */
export function explainStoredDecision(
  record: StoredDecisionFacts,
  proposal?: StoredProposalFacts | null,
): DecisionExplanation | null {
  try {
    if (!isPolicyDecision(record.decision)) return null;
    const reasonCodes = Array.isArray(record.reasonCodes)
      ? record.reasonCodes.filter((code): code is string => typeof code === "string")
      : [];
    const rules = CanonicalMandateSchema.safeParse(record.rulesSnapshot);
    const spend = isRecord(record.spendSnapshot) ? record.spendSnapshot : null;
    const total = proposal ? safeMinor(proposal.total) : null;
    const product = proposal?.productSnapshot ?? null;
    return explainDecision({
      decision: record.decision,
      reasonCodes,
      rules: rules.success ? rules.data : null,
      mandateVersion: proposal?.mandateVersion?.version ?? null,
      proposal:
        proposal && total !== null
          ? { total, currency: proposal.currency, quantity: proposal.quantity }
          : null,
      product: product
        ? {
            brand: product.brand,
            category: product.category,
            condition: product.condition,
            merchant: product.merchant,
          }
        : null,
      committedSpend: committedSpend(spend),
      isNewMerchant: typeof spend?.isNewMerchant === "boolean" ? spend.isNewMerchant : null,
      userAutonomyEnabled:
        typeof spend?.globalAutonomousPurchasingEnabled === "boolean"
          ? spend.globalAutonomousPurchasingEnabled
          : null,
    });
  } catch {
    return null;
  }
}
