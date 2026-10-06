import type { ReactNode } from "react";

export function DefinitionList({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 rounded-2xl border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-2 break-words text-sm font-medium">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
