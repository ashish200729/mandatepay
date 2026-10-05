export type TableQuerySpec = {
  search?: boolean;
  filters?: Record<string, readonly string[]>;
  dates?: boolean;
  sortKeys?: readonly string[];
};
export function tableQueryKeys(spec: TableQuerySpec) {
  return [
    "limit",
    "cursor",
    ...(spec.search ? ["q"] : []),
    ...Object.keys(spec.filters ?? {}),
    ...(spec.dates ? ["from", "to"] : []),
    ...(spec.sortKeys?.length ? ["sort", "direction"] : []),
  ];
}
function utcDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"))
  );
}
export function readTableQuery(input: URLSearchParams, spec: TableQuerySpec) {
  const params = new URLSearchParams(input);
  let error: string | null = null;
  const keys = tableQueryKeys(spec);
  if ([...params.keys()].some((key) => !keys.includes(key) || params.getAll(key).length !== 1))
    error = "This view has unsupported or repeated filters. Clear filters to reset it.";
  const limitText = params.get("limit") ?? "50";
  const limit = Number(limitText);
  if (!/^\d{1,3}$/u.test(limitText) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    error = "Choose a page size between 1 and 100.";
  if (params.has("cursor") && (!params.get("cursor") || params.get("cursor")!.length > 2048))
    error = "This page link is invalid. Clear filters to reset it.";
  if (params.has("q")) {
    const query = params.get("q")!.trim();
    if (query.length > 200) error = "Search must be 200 characters or fewer.";
    if (query) params.set("q", query);
    else params.delete("q");
  }
  for (const [key, values] of Object.entries(spec.filters ?? {}))
    if (params.has(key) && !values.includes(params.get(key)!))
      error = "Choose a supported filter value.";
  const from = params.get("from"),
    to = params.get("to");
  if (from || to) {
    if (
      !from ||
      !to ||
      !utcDate(from) ||
      !utcDate(to) ||
      Date.parse(from) >= Date.parse(to) ||
      Date.parse(to) - Date.parse(from) > 366 * 86400_000
    )
      error = "Choose both UTC dates in order, at most 366 days apart.";
  } else if (params.has("from") || params.has("to"))
    error = "Choose both dates or clear the date range.";
  const sort = params.get("sort"),
    direction = params.get("direction");
  if (
    (sort && !spec.sortKeys?.includes(sort)) ||
    (direction && (!sort || !["asc", "desc"].includes(direction))) ||
    (params.has("sort") && !sort) ||
    (params.has("direction") && !direction)
  )
    error = "Choose a supported sort order.";
  return {
    params,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50,
    cursor: params.get("cursor"),
    sort,
    direction: direction === "asc" ? ("asc" as const) : ("desc" as const),
    error,
  };
}
/** Filters/sort/page-size changes always reset pagination; cursor changes preserve the view. */
export function updateTableQuery(
  current: URLSearchParams,
  changes: Record<string, string | null>,
  spec: TableQuerySpec,
) {
  const allowed = tableQueryKeys(spec);
  const params = new URLSearchParams([...current].filter(([key]) => allowed.includes(key)));
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed.includes(key)) throw new Error("Unsupported table filter.");
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  if (Object.keys(changes).some((key) => key !== "cursor")) params.delete("cursor");
  const result = readTableQuery(params, spec);
  if (result.error) throw new Error(result.error);
  result.params.sort();
  return result.params;
}
export function utcDateRange(from: string, through: string) {
  if (!from && !through) return { from: null, to: null };
  const start = `${from}T00:00:00.000Z`,
    end = `${through}T00:00:00.000Z`;
  if (!utcDate(start) || !utcDate(end)) throw new Error("Choose both UTC dates.");
  const to = new Date(Date.parse(end) + 86400_000).toISOString();
  if (Date.parse(start) >= Date.parse(to) || Date.parse(to) - Date.parse(start) > 366 * 86400_000)
    throw new Error("Choose a UTC range of at most 366 days.");
  return { from: start, to };
}
export function dateRangeInputs(params: URLSearchParams) {
  const from = params.get("from"),
    to = params.get("to");
  return {
    from: from && utcDate(from) ? from.slice(0, 10) : "",
    through: to && utcDate(to) ? new Date(Date.parse(to) - 1).toISOString().slice(0, 10) : "",
  };
}

/** Preserve precise bookmarked timestamps when the operator changes other filters. */
export function dateRangeFilterUpdate(params: URLSearchParams, from: string, through: string) {
  const current = dateRangeInputs(params);
  const originalFrom = params.get("from"),
    originalTo = params.get("to");
  if (
    from === current.from &&
    through === current.through &&
    originalFrom &&
    originalTo &&
    utcDate(originalFrom) &&
    utcDate(originalTo)
  )
    return { from: originalFrom, to: originalTo };
  return utcDateRange(from, through);
}
