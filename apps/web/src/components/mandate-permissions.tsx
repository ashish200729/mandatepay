import { formatUsdLabel, formatUtcDate } from "@/lib/mandates/money";
import type { CanonicalMandate } from "@/lib/mandates/types";

export function MandatePermissions({ mandate }: { mandate: CanonicalMandate }) {
  const rules = [
    ["Allowed brands", mandate.allowedBrands.join(", ") || "Any brand"],
    ["Condition", mandate.allowedConditions.join(", ")],
    ["Allowed categories", mandate.allowedCategories.join(", ") || "Any category"],
    ["Quantity limit", String(mandate.quantityLimit)],
    ["Allowed merchants", mandate.allowedMerchants.join(", ") || "Any merchant"],
    [
      "New merchant",
      mandate.newMerchantRequiresApproval ? "Approval required" : "No additional mandate approval",
    ],
    ["Blocked brands", mandate.blockedBrands.join(", ") || "None"],
    ["Blocked categories", mandate.blockedCategories.join(", ") || "None"],
    ["Blocked merchants", mandate.blockedMerchants.join(", ") || "None"],
    [
      "Daily limit",
      mandate.dailyLimit === undefined ? "Not set" : formatUsdLabel(mandate.dailyLimit),
    ],
    [
      "Weekly limit",
      mandate.weeklyLimit === undefined ? "Not set" : formatUsdLabel(mandate.weeklyLimit),
    ],
    [
      "Monthly limit",
      mandate.monthlyLimit === undefined ? "Not set" : formatUsdLabel(mandate.monthlyLimit),
    ],
    ["Starts at · UTC", mandate.startsAt ? formatUtcDate(mandate.startsAt) : "No scheduled start"],
    [
      "Expires at · UTC",
      mandate.expiresAt ? formatUtcDate(mandate.expiresAt) : "24-hour server default",
    ],
  ];
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7">
      <h3 className="text-lg font-medium">{mandate.title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{mandate.productIntent}</p>
      <dl className="mt-5 grid grid-cols-2 gap-5 border-y border-border py-5">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Maximum transaction · USD</dt>
          <dd className="mt-2 break-words text-2xl font-medium tabular-nums">
            {formatUsdLabel(mandate.transactionLimit)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Automatic spending · USD</dt>
          <dd className="mt-2 break-words text-2xl font-medium tabular-nums">
            {formatUsdLabel(mandate.autoSpendLimit)}
          </dd>
        </div>
      </dl>
      <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5">
        {rules.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-sm font-medium leading-6">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
