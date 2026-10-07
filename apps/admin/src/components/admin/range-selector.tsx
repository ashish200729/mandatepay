"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import {
  ADMIN_OVERVIEW_RANGE_PRESETS,
  matchingOverviewPreset,
  overviewRangeFromPreset,
} from "@mandatepay/shared";
import { DateRangeFilter } from "./filters";
import { dateRangeInputs, utcDateRange } from "@/lib/table-query";

export function OverviewRangeSelector({
  from,
  to,
  asOf,
  path = "/",
  keep,
}: {
  from: string;
  to: string;
  asOf: string;
  path?: string;
  keep?: string;
}) {
  const router = useRouter();
  const formId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = matchingOverviewPreset(from, to, asOf);
  const dates = dateRangeInputs(new URLSearchParams({ from, to }));
  function go(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(keep ?? "");
    params.set("from", nextFrom);
    params.set("to", nextTo);
    startTransition(() => router.push(`${path}?${params.toString()}`));
  }
  return (
    <section aria-label="Time range" className="mb-8 rounded-2xl border bg-secondary/50 p-4">
      <div className="flex flex-wrap gap-2">
        {ADMIN_OVERVIEW_RANGE_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant={current === preset.id ? "secondary" : "outline"}
            disabled={pending}
            aria-pressed={current === preset.id}
            onClick={() => {
              const range = overviewRangeFromPreset(preset.days, new Date(asOf));
              setError(null);
              go(range.from, range.to);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <form
        id={formId}
        className="mt-4 flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const range = utcDateRange(
              String(data.get("fromDate") ?? ""),
              String(data.get("throughDate") ?? ""),
            );
            if (!range.from || !range.to) throw new Error("Choose both UTC dates.");
            setError(null);
            go(range.from, range.to);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Choose a valid UTC range.");
          }
        }}
      >
        <div className="min-w-0 flex-[2_1_280px]">
          <DateRangeFilter from={dates.from} through={dates.through} disabled={pending} />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Updating…" : "Apply custom range"}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Half-open UTC interval from {from} through {to}. Flow metrics use this window;
          current-state counts remain as of {asOf}.
        </p>
      )}
    </section>
  );
}
