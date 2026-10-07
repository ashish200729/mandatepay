import { describe, expect, it } from "vitest";
import { overviewApiPath, readOverviewSearch } from "./overview-query";

describe("overview time-range query", () => {
  it("accepts a paired UTC window and rejects unpaired or oversized ranges", () => {
    expect(readOverviewSearch({})).toEqual({ search: "", error: null });
    expect(
      readOverviewSearch({
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-08T00:00:00.000Z",
      }).search,
    ).toContain("from=2026-10-01");
    expect(readOverviewSearch({ from: "2026-10-01T00:00:00.000Z" }).error).toMatch(/UTC dates/u);
    expect(
      readOverviewSearch({
        from: "2025-01-01T00:00:00.000Z",
        to: "2026-10-08T00:00:00.000Z",
      }).error,
    ).toMatch(/366 days/u);
    expect(overviewApiPath("from=a&to=b")).toBe("/api/admin/overview?from=a&to=b");
  });
});
