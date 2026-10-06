"use client";
import { useId, useState } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { dateRangeInputs, dateRangeFilterUpdate } from "@/lib/table-query";
import type { TableNavigation } from "@/lib/use-table-query";

const fieldClass = "h-11 min-w-0 w-full rounded-xl border bg-card px-3 text-sm disabled:opacity-50";
export function SearchInput({
  name = "q",
  label = "Search",
  defaultValue,
  disabled,
}: {
  name?: string;
  label?: string;
  defaultValue?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block min-w-0 text-xs font-medium">
      <span className="mb-2 block">{label}</span>
      <input
        id={id}
        type="search"
        name={name}
        defaultValue={defaultValue}
        maxLength={200}
        disabled={disabled}
        className={fieldClass}
      />
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
}: {
  navigation: TableNavigation;
  search?: { label: string };
  filters?: readonly SelectFilter[];
  fields?: readonly TextFilter[];
  dates?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const inputDates = dateRangeInputs(navigation.query.params);
  return (
    <div className="mb-5 rounded-2xl border bg-secondary/50 p-4">
      <form
        key={navigation.query.params.toString()}
        aria-label="Table filters"
        className="flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const values: Record<string, string | null> = { limit: String(data.get("limit")) };
            if (search) values.q = String(data.get("q") ?? "").trim();
            for (const filter of filters) values[filter.key] = String(data.get(filter.key) ?? "");
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
            navigation.apply(values);
            setError(null);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Check your filters.");
          }
        }}
      >
        {search && (
          <div className="min-w-0 flex-[1_1_200px]">
            <SearchInput
              label={search.label}
              defaultValue={navigation.query.params.get("q") ?? ""}
              disabled={navigation.pending}
            />
          </div>
        )}
        {filters.map((filter) => (
          <label key={filter.key} className="min-w-0 flex-[1_1_150px] text-xs font-medium">
            <span className="mb-2 block">{filter.label}</span>
            <select
              aria-label={filter.label}
              name={filter.key}
              defaultValue={navigation.query.params.get(filter.key) ?? ""}
              disabled={navigation.pending}
              className={fieldClass}
            >
              <option value="">All</option>
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
              type={field.kind === "number" ? "text" : "text"}
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
        <label className="w-28 text-xs font-medium">
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
        <div className="flex flex-wrap gap-2">
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
        </div>
      </form>
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
