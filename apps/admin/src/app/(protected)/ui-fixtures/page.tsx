import { requireUiFixtures } from "@/lib/ui-fixtures";
import { readTableQuery } from "@/lib/table-query";
import { UiFixtures } from "@/components/admin/ui-fixtures";
import { fixtureSpec, type FixtureRow } from "@/lib/ui-fixture-data";

export default async function FixturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireUiFixtures();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  const query = readTableQuery(params, fixtureSpec);
  const rows: FixtureRow[] = Array.from({ length: 6 }, (_, index) => ({
    id: `fixture-${index + 1}`,
    name: `Record ${String(index + 1).padStart(2, "0")}`,
    status: index % 2 ? "FAILURE" : "SUCCESS",
    createdAt: `2026-10-0${index + 1}T12:00:00.000Z`,
  }));
  const matching = rows.filter(
    (row) =>
      (!query.params.get("q") ||
        row.name.toLowerCase().includes(query.params.get("q")!.toLowerCase())) &&
      (!query.params.get("status") || row.status === query.params.get("status")) &&
      (!query.params.get("from") ||
        Date.parse(row.createdAt) >= Date.parse(query.params.get("from")!)) &&
      (!query.params.get("to") || Date.parse(row.createdAt) < Date.parse(query.params.get("to")!)),
  );
  const key = query.sort === "name" ? "name" : "createdAt";
  matching.sort(
    (a, b) =>
      (a[key].localeCompare(b[key]) || a.id.localeCompare(b.id)) *
      (query.direction === "asc" ? 1 : -1),
  );
  const offset = query.cursor && /^\d+$/u.test(query.cursor) ? Number(query.cursor) : 0;
  const data = matching.slice(offset, offset + query.limit);
  const nextCursor = offset + query.limit < matching.length ? String(offset + query.limit) : null;
  return (
    <UiFixtures
      state={
        query.error
          ? { status: "error", description: query.error }
          : { status: "ready", data, page: { limit: query.limit, nextCursor } }
      }
    />
  );
}
