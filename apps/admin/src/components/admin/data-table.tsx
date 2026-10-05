"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { EmptyState, ErrorState, LoadingSkeleton } from "./states";

export type TableColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  sortKey?: string;
};
export type TableState<T> =
  | { status: "loading" }
  | { status: "error"; description?: string }
  | { status: "ready"; data: readonly T[]; page: { limit: number; nextCursor: string | null } };
export function Pagination({
  shown,
  limit,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  pending,
}: {
  shown: number;
  limit: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  pending?: boolean;
}) {
  return (
    <nav
      aria-label="Table pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p role="status" className="text-xs text-muted-foreground">
        {shown} {shown === 1 ? "record" : "records"} on this page · up to {limit}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending || !hasPrevious} onClick={onPrevious}>
          Previous
        </Button>
        <Button variant="outline" disabled={pending || !hasNext} onClick={onNext}>
          Next
        </Button>
      </div>
    </nav>
  );
}
export function DataTable<T>({
  caption,
  state,
  columns,
  getRowId,
  rowHref,
  onRetry,
  onNext,
  onPrevious,
  hasPrevious = false,
  pending = false,
  sort,
  onSort,
  emptyDescription = "Records will appear here when available. Try changing your filters.",
}: {
  caption: string;
  state: TableState<T>;
  columns: readonly TableColumn<T>[];
  getRowId: (row: T) => string;
  rowHref?: (row: T) => string;
  onRetry: () => void;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
  hasPrevious?: boolean;
  pending?: boolean;
  sort?: { key: string | null; direction: "asc" | "desc" };
  onSort?: (key: string) => void;
  emptyDescription?: string;
}) {
  if (state.status === "loading")
    return <LoadingSkeleton label={`Loading ${caption.toLowerCase()}…`} />;
  if (state.status === "error")
    return <ErrorState description={state.description} onRetry={onRetry} pending={pending} />;
  return (
    <section aria-label={caption} aria-busy={pending}>
      {onSort && columns.some((column) => column.sortKey) && (
        <div aria-label="Sort records" className="mb-3 flex flex-wrap gap-2 lg:hidden">
          {columns
            .filter((column) => column.sortKey)
            .map((column) => (
              <Button
                key={column.key}
                variant="outline"
                disabled={pending}
                onClick={() => onSort(column.sortKey!)}
              >
                Sort by {column.label}
                {sort?.key === column.sortKey
                  ? ` · ${sort?.direction === "asc" ? "ascending" : "descending"}`
                  : ""}
              </Button>
            ))}
        </div>
      )}
      {!state.data.length ? (
        <EmptyState description={emptyDescription} />
      ) : (
        <>
          <div
            className="hidden overflow-x-auto rounded-2xl border bg-card lg:block"
            role="region"
            aria-label={`${caption} table, scroll for all columns`}
            tabIndex={0}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{caption}</caption>
              <thead className="border-b bg-secondary/70">
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        column.sortKey && sort?.key === column.sortKey
                          ? sort?.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : column.sortKey
                            ? "none"
                            : undefined
                      }
                      className="px-4 py-3 font-medium"
                    >
                      {column.sortKey && onSort ? (
                        <button
                          className="inline-flex min-h-11 items-center gap-2 rounded text-left"
                          disabled={pending}
                          onClick={() => onSort(column.sortKey!)}
                        >
                          {column.label}
                          <span aria-hidden="true">
                            {sort?.key === column.sortKey
                              ? sort?.direction === "asc"
                                ? "↑"
                                : "↓"
                              : "↕"}
                          </span>
                          <span className="sr-only">
                            , sort{" "}
                            {sort?.key === column.sortKey && sort?.direction === "asc"
                              ? "descending"
                              : "ascending"}
                          </span>
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  ))}
                  {rowHref && (
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Record</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.data.map((row) => (
                  <tr key={getRowId(row)} className="align-top hover:bg-secondary/40">
                    {columns.map((column) => (
                      <td key={column.key} className="max-w-sm break-words px-4 py-4">
                        {column.render(row)}
                      </td>
                    ))}
                    {rowHref && (
                      <td className="px-4 py-4">
                        <Link
                          href={rowHref(row)}
                          className="inline-flex min-h-11 items-center rounded text-xs underline underline-offset-4"
                        >
                          View<span className="sr-only"> record {getRowId(row)}</span>
                        </Link>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 lg:hidden">
            {state.data.map((row) => (
              <li key={getRowId(row)} className="rounded-2xl border bg-card p-5">
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-3">
                  {columns.map((column) => (
                    <div key={column.key} className="contents">
                      <dt className="break-words text-xs text-muted-foreground">{column.label}</dt>
                      <dd className="min-w-0 break-words text-sm">{column.render(row)}</dd>
                    </div>
                  ))}
                </dl>
                {rowHref && (
                  <Link
                    href={rowHref(row)}
                    className="mt-3 inline-flex min-h-11 items-center rounded text-sm underline"
                  >
                    View record<span className="sr-only"> {getRowId(row)}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Pagination
        shown={state.data.length}
        limit={state.page.limit}
        hasPrevious={hasPrevious}
        hasNext={Boolean(state.page.nextCursor)}
        pending={pending}
        onPrevious={onPrevious}
        onNext={() => {
          if (state.page.nextCursor) onNext(state.page.nextCursor);
        }}
      />
    </section>
  );
}
