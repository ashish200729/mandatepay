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
import { adminFieldClass } from "@/lib/control-styles";

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
  const panelId = useId();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = matchingOverviewPreset(from, to, asOf);
  const dates = dateRangeInputs(new URLSearchParams({ from, to }));
  function go(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(keep ?? "");
    params.set("from", nextFrom);
    params.set("to", nextTo);
    startTransition(() => router.push(path + "?" + params.toString()));
  }
  return (
    <section aria-label="Time range" className="mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">Time period</span>
          <select
            aria-label="Time period"
            value={current ?? "custom"}
            disabled={pending}
            className={adminFieldClass + " w-auto"}
            onChange={(event) => {
              const preset = ADMIN_OVERVIEW_RANGE_PRESETS.find(
                (preset) => preset.id === event.target.value,
              );
              if (!preset) {
                setExpanded(true);
                return;
              }
              const range = overviewRangeFromPreset(preset.days, new Date(asOf));
              setError(null);
              go(range.from, range.to);
            }}
          >
            {ADMIN_OVERVIEW_RANGE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom dates</option>
          </select>
        </label>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(!expanded)}
        >
          Custom dates
        </Button>
        {current === null && (
          <p className="text-xs text-muted-foreground">
            {dates.from} – {dates.through} · UTC
          </p>
        )}
      </div>
      <div
        id={panelId}
        hidden={!expanded}
        className="mt-4 max-w-2xl rounded-xl border bg-secondary/30 p-4"
      >
        <form
          key={from + ":" + to}
          className="flex flex-wrap items-end gap-3"
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
          <div className="min-w-0 flex-[1_1_260px]">
            <DateRangeFilter from={dates.from} through={dates.through} disabled={pending} />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Updating…" : "Apply custom range"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-admin-danger-foreground">
            {error}
          </p>
        )}
        <details className="mt-2 text-xs leading-5 text-muted-foreground">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded underline">
            Time range details
          </summary>
          <p className="[overflow-wrap:anywhere]">
            Half-open UTC interval from {from} through {to}. Flow metrics use this window;
            current-state counts remain as of {asOf}.
          </p>
        </details>
      </div>
      {pending && (
        <span role="status" className="sr-only">
          Updating the reporting window…
        </span>
      )}
    </section>
  );
}
