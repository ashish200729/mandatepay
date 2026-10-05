import { describe, expect, it } from "vitest";
import {
  readTableQuery,
  updateTableQuery,
  utcDateRange,
  dateRangeInputs,
  dateRangeFilterUpdate,
} from "./table-query";
const spec = {
  search: true,
  dates: true,
  filters: { status: ["SUCCESS", "FAILURE"] },
  sortKeys: ["createdAt"],
};
describe("server table URL contract", () => {
  it("preserves precise time bounds when applying unrelated filters", () => {
    const precise = { from: "2026-10-01T12:30:00.000Z", to: "2026-10-05T14:00:00.000Z" };
    const params = new URLSearchParams(precise);
    expect(dateRangeInputs(params)).toEqual({ from: "2026-10-01", through: "2026-10-05" });
    expect(dateRangeFilterUpdate(params, "2026-10-01", "2026-10-05")).toEqual(precise);
    expect(dateRangeFilterUpdate(params, "2026-10-01", "2026-10-06").to).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });
  it("rejects unbounded, repeated, unknown, invalid date and unsupported sort filters", () => {
    for (const query of [
      "limit=101",
      "limit=1e2",
      "limit=0",
      "limit=1&limit=1",
      "status=OTHER",
      "raw=secret",
      "cursor=",
      "cursor=" + "x".repeat(2049),
      "q=" + "x".repeat(201),
      "from=2026-10-05T00:00:00Z",
      "from=2026-02-30T00:00:00Z&to=2026-03-05T00:00:00Z",
      "sort=password",
      "direction=asc",
    ])
      expect(readTableQuery(new URLSearchParams(query), spec).error, query).not.toBeNull();
    expect(
      readTableQuery(
        new URLSearchParams("limit=2&status=SUCCESS&sort=createdAt&direction=asc"),
        spec,
      ),
    ).toMatchObject({ error: null, limit: 2, sort: "createdAt", direction: "asc" });
  });
  it("preserves the view for cursor navigation and clears cursor when changing filters/sort", () => {
    const current = new URLSearchParams("q=record&status=SUCCESS&cursor=opaque&limit=25");
    expect(updateTableQuery(current, { cursor: "next" }, spec).toString()).toBe(
      "cursor=next&limit=25&q=record&status=SUCCESS",
    );
    expect(updateTableQuery(current, { status: "FAILURE" }, spec).get("cursor")).toBeNull();
    expect(
      updateTableQuery(current, { sort: "createdAt", direction: "asc" }, spec).get("cursor"),
    ).toBeNull();
    expect(() => updateTableQuery(current, { token: "secret" }, spec)).toThrow();
  });
  it("converts inclusive date controls into a bounded half-open UTC API range", () => {
    const range = utcDateRange("2026-10-01", "2026-10-05");
    expect(range).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" });
    expect(dateRangeInputs(new URLSearchParams({ from: range.from!, to: range.to! }))).toEqual({
      from: "2026-10-01",
      through: "2026-10-05",
    });
    expect(utcDateRange("2024-02-29", "2024-02-29").to).toBe("2024-03-01T00:00:00.000Z");
    for (const pair of [
      ["2026-02-30", "2026-03-01"],
      ["", "2026-10-05"],
      ["2026-10-05", "2026-10-01"],
      ["2025-01-01", "2026-10-01"],
    ])
      expect(() => utcDateRange(pair[0]!, pair[1]!)).toThrow();
    expect(utcDateRange("", "")).toEqual({ from: null, to: null });
  });
});
