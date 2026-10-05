"use client";
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { readTableQuery, updateTableQuery, type TableQuerySpec } from "./table-query";

export function useTableQuery(spec: TableQuerySpec) {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const query = readTableQuery(new URLSearchParams(search.toString()), spec);
  const [pending, startTransition] = useTransition();
  const [trail, setTrail] = useState<{ url: string; cursor: string; view: string }[]>([]);
  const viewParams = new URLSearchParams(query.params);
  viewParams.delete("cursor");
  viewParams.sort();
  const view = viewParams.toString();
  const previous = trail.at(-1);
  const hasPrevious = Boolean(
    previous && previous.cursor === query.cursor && previous.view === view,
  );
  function go(params: URLSearchParams) {
    startTransition(() =>
      router.push(`${pathname}${params.size ? "?" + params : ""}`, { scroll: false }),
    );
  }
  return {
    query,
    pending,
    apply(changes: Record<string, string | null>) {
      const params = updateTableQuery(query.params, changes, spec);
      setTrail([]);
      go(params);
    },
    clear() {
      setTrail([]);
      go(new URLSearchParams());
    },
    sort(key: string) {
      const params = updateTableQuery(
        query.params,
        { sort: key, direction: query.sort === key && query.direction === "asc" ? "desc" : "asc" },
        spec,
      );
      setTrail([]);
      go(params);
    },
    next(cursor: string) {
      const params = updateTableQuery(query.params, { cursor }, spec);
      setTrail((current) => [
        ...current.slice(-9),
        { url: `${pathname}${search.size ? "?" + search : ""}`, cursor, view },
      ]);
      go(params);
    },
    previous() {
      if (!hasPrevious || !previous) return;
      setTrail((current) => current.slice(0, -1));
      startTransition(() => router.push(previous.url, { scroll: false }));
    },
    hasPrevious,
  };
}
export type TableNavigation = ReturnType<typeof useTableQuery>;
