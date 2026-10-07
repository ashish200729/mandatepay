import type { ReactNode } from "react";
import { DisclosureSection } from "./disclosure-section";

const diagnosticLabels = new Set([
  "PayPal order ID",
  "PayPal capture ID",
  "PayPal refund ID",
  "Invoice ID",
  "Provider event ID",
  "Request",
]);

export function DefinitionList({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[];
}) {
  const primary = items.filter((item) => !diagnosticLabels.has(item.label));
  const diagnostic = items.filter((item) => diagnosticLabels.has(item.label));
  function ledger(rows: typeof items) {
    return (
      <dl className="grid overflow-hidden rounded-xl border bg-card sm:grid-cols-2">
        {rows.map((item) => (
          <div
            key={item.label}
            className="min-w-0 border-b px-5 py-4 last:border-b-0 sm:odd:border-r sm:[&:nth-last-child(2):nth-child(odd)]:border-b-0"
          >
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-2 text-sm font-medium leading-6 tabular-nums [overflow-wrap:anywhere]">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <>
      {primary.length > 0 && ledger(primary)}
      {diagnostic.length > 0 && (
        <DisclosureSection title="Technical identifiers" className="mt-4">
          {ledger(diagnostic)}
        </DisclosureSection>
      )}
    </>
  );
}
