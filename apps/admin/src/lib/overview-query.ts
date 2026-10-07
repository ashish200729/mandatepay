import { AdminOverviewQuerySchema } from "@mandatepay/shared";

export function readOverviewSearch(input: Record<string, string | string[] | undefined>) {
  const from = typeof input.from === "string" ? input.from : undefined;
  const to = typeof input.to === "string" ? input.to : undefined;
  if (from === undefined && to === undefined) return { search: "", error: null as string | null };
  const parsed = AdminOverviewQuerySchema.safeParse({ from, to });
  if (!parsed.success || !parsed.data.from || !parsed.data.to) {
    return {
      search: "",
      error: "Choose both UTC dates in order, at most 366 days apart.",
    };
  }
  const params = new URLSearchParams({ from: parsed.data.from, to: parsed.data.to });
  return { search: params.toString(), error: null as string | null };
}

export function overviewApiPath(search: string) {
  return search ? `/api/admin/overview?${search}` : "/api/admin/overview";
}

export function activityApiPath(search: string) {
  return search
    ? `/api/admin/overview/activity?limit=20&${search}`
    : "/api/admin/overview/activity?limit=20";
}
