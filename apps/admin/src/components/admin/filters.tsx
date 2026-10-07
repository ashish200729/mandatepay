"use client";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { dateRangeInputs, dateRangeFilterUpdate } from "@/lib/table-query";
import type { TableNavigation } from "@/lib/use-table-query";
import { adminFieldClass } from "@/lib/control-styles";
import { Search, SlidersHorizontal, X } from "lucide-react";

const fieldClass = adminFieldClass;
export function SearchInput({
  name = "q",
  label = "Search",
  defaultValue,
  disabled,
  compact = false,
}: {
  name?: string;
  label?: string;
  defaultValue?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block min-w-0 text-xs font-medium">
      <span className={compact ? "sr-only" : "mb-2 block"}>{label}</span>
      <div className="relative">
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground"
        />
        <input
          id={id}
          type="search"
          name={name}
          defaultValue={defaultValue}
          maxLength={200}
          placeholder={compact ? label : undefined}
          disabled={disabled}
          className={`${fieldClass} pl-9`}
        />
      </div>
    </label>
  );
}
export function DateRangeFilter({
  from,
  through,
  disabled,
}: {
  from: string;
  through: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium">Date range · UTC</legend>
      <div className="grid grid-cols-2 gap-3">
        <label htmlFor={`${id}-from`} className="min-w-0 text-xs">
          <span className="sr-only">From date</span>
          <input
            id={`${id}-from`}
            aria-label="From date"
            name="fromDate"
            type="date"
            defaultValue={from}
            disabled={disabled}
            className={fieldClass}
          />
        </label>
        <label htmlFor={`${id}-to`} className="min-w-0 text-xs">
          <span className="sr-only">Through date</span>
          <input
            id={`${id}-to`}
            aria-label="Through date"
            name="throughDate"
            type="date"
            defaultValue={through}
            disabled={disabled}
            className={fieldClass}
          />
        </label>
      </div>
    </fieldset>
  );
}
export type SelectFilter = {
  key: string;
  label: string;
  options: readonly { value: string; label: string }[];
};
export type TextFilter = { key: string; label: string; kind?: "text" | "number" };
export function FilterBar({
  navigation,
  search,
  filters = [],
  fields = [],
  dates = false,
  primaryFilterKey,
  actions,
}: {
  navigation: TableNavigation;
  search?: { label: string };
  filters?: readonly SelectFilter[];
  fields?: readonly TextFilter[];
  dates?: boolean;
  primaryFilterKey?: string;
  actions?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const inputDates = dateRangeInputs(navigation.query.params);
  const primary = filters.find((filter) => filter.key === primaryFilterKey);
  const additional = filters.filter((filter) => filter !== primary);
  const active = [
    ...additional.map((filter) => ({
      key: filter.key,
      label: filter.label,
      value: filter.options.find(
        (option) => option.value === navigation.query.params.get(filter.key),
      )?.label,
    })),
    ...fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: navigation.query.params.get(field.key),
    })),
  ].filter((item) => item.value);
  if (dates && inputDates.from && inputDates.through)
    active.push({
      key: "dates",
      label: "Dates · UTC",
      value: `${inputDates.from} – ${inputDates.through}`,
    });
  const hasFilters =
    active.length > 0 ||
    Boolean(navigation.query.params.get("q")) ||
    Boolean(primary && navigation.query.params.get(primary.key));
  return (
    <div className="mb-5">
      <form
        key={navigation.query.params.toString()}
        aria-label="Table filters"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const values: Record<string, string | null> = {};
            if (search) values.q = String(data.get("q") ?? "").trim();
            if (primary) values[primary.key] = String(data.get(primary.key) ?? "");
            if (expanded) {
              values.limit = String(data.get("limit"));
              for (const filter of additional)
                values[filter.key] = String(data.get(filter.key) ?? "");
              for (const field of fields)
                values[field.key] = String(data.get(field.key) ?? "").trim();
              if (dates)
                Object.assign(
                  values,
                  dateRangeFilterUpdate(
                    navigation.query.params,
                    String(data.get("fromDate") ?? ""),
                    String(data.get("throughDate") ?? ""),
                  ),
                );
            }
            navigation.apply(values);
            setError(null);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Check your filters.");
          }
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          {search && (
            <div className="flex min-w-0 flex-[1_1_260px] items-end gap-2 sm:max-w-md">
              <SearchInput
                label={search.label}
                defaultValue={navigation.query.params.get("q") ?? ""}
                disabled={navigation.pending}
                compact
              />
              <Button type="submit" variant="outline" disabled={navigation.pending}>
                Search
              </Button>
            </div>
          )}
          {primary && (
            <label className="min-w-0 flex-[1_1_140px] text-xs font-medium sm:max-w-44">
              <span className="sr-only">{primary.label}</span>
              <select
                aria-label={primary.label}
                name={primary.key}
                defaultValue={navigation.query.params.get(primary.key) ?? ""}
                disabled={navigation.pending}
                className={fieldClass}
                onChange={(event) => event.currentTarget.form?.requestSubmit()}
              >
                <option value="">
                  All{" "}
                  {primary.label.toLowerCase().includes("status")
                    ? "statuses"
                    : primary.label.toLowerCase() === "decision"
                      ? "decisions"
                      : "results"}
                </option>
                {primary.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            type="button"
            variant={expanded ? "secondary" : "outline"}
            aria-expanded={expanded}
            aria-controls={panelId}
            disabled={navigation.pending}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            Filters{active.length > 0 ? ` (${active.length})` : ""}
          </Button>
          {actions && <div className="flex items-center sm:ml-auto">{actions}</div>}
        </div>
        <div
          id={panelId}
          hidden={!expanded}
          className="rounded-xl border bg-secondary/30 p-4 sm:p-5"
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {additional.map((filter) => (
              <label key={filter.key} className="min-w-0 flex-[1_1_150px] text-xs font-medium">
                <span className="mb-2 block">{filter.label}</span>
                <select
                  aria-label={filter.label}
                  name={filter.key}
                  defaultValue={navigation.query.params.get(filter.key) ?? ""}
                  disabled={navigation.pending}
                  className={fieldClass}
                >
                  <option value="">
                    {filter.key === "dateBasis"
                      ? "Created date (default)"
                      : filter.key === "includeSamples"
                        ? "Exclude samples (default)"
                        : "All"}
                  </option>
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {fields.map((field) => (
              <label key={field.key} className="min-w-0 flex-[1_1_160px] text-xs font-medium">
                <span className="mb-2 block">{field.label}</span>
                <input
                  aria-label={field.label}
                  name={field.key}
                  type="text"
                  inputMode={field.kind === "number" ? "numeric" : "text"}
                  defaultValue={navigation.query.params.get(field.key) ?? ""}
                  disabled={navigation.pending}
                  className={fieldClass}
                />
              </label>
            ))}
            {dates && (
              <div className="min-w-0 flex-[2_1_280px]">
                <DateRangeFilter {...inputDates} disabled={navigation.pending} />
              </div>
            )}
            <label className="min-w-0 max-w-32 text-xs font-medium">
              <span className="mb-2 block">Page size</span>
              <select
                name="limit"
                defaultValue={navigation.query.limit}
                disabled={navigation.pending}
                className={fieldClass}
              >
                {[...new Set([25, 50, 100, navigation.query.limit])]
                  .sort((a, b) => a - b)
                  .map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="mt-5 flex min-h-11 flex-wrap gap-2 border-t pt-4">
            <Button type="submit" disabled={navigation.pending}>
              {navigation.pending ? "Applying…" : "Apply filters"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={navigation.pending}
              onClick={() => {
                setError(null);
                navigation.clear();
              }}
            >
              Clear filters
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={navigation.pending}
              onClick={() => setExpanded(false)}
            >
              Close filters
            </Button>
          </div>
        </div>
      </form>
      {(hasFilters || navigation.query.error) && (
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Applied filters">
          {active.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-label={`Clear ${item.label} filter`}
              disabled={navigation.pending || Boolean(navigation.query.error)}
              onClick={() => {
                setError(null);
                navigation.apply(
                  item.key === "dates" ? { from: null, to: null } : { [item.key]: null },
                );
              }}
              className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border bg-secondary/40 px-3 text-xs disabled:opacity-50"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {item.label}: {item.value}
              </span>
              <X size={13} aria-hidden="true" className="shrink-0" />
            </button>
          ))}
          {!expanded && (
            <Button
              type="button"
              variant="ghost"
              disabled={navigation.pending}
              onClick={() => {
                setError(null);
                navigation.clear();
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      )}
      {(error || navigation.query.error) && (
        <p role="alert" className="mt-3 text-sm text-admin-danger-foreground">
          {error ?? navigation.query.error}
        </p>
      )}
      {navigation.pending && (
        <p role="status" className="sr-only">
          Updating this view…
        </p>
      )}
    </div>
  );
}
