import { describe, expect, it } from "vitest";
import {
  ADMIN_CHART_SERIES_MAX,
  ADMIN_METRIC_DEFINITIONS,
  ADMIN_OVERVIEW_CHART_METRIC_KEYS,
  ADMIN_OVERVIEW_RANGE_PRESETS,
  AdminOverviewSchema,
  errorCategoryKey,
  fillUtcDaySeries,
  matchingOverviewPreset,
  overviewRangeFromPreset,
  topErrorCategories,
} from "../src/index.js";

describe("admin dashboard metric contracts", () => {
  it("keeps explicit definitions for every overview chart metric", () => {
    for (const key of ADMIN_OVERVIEW_CHART_METRIC_KEYS) {
      const definition = ADMIN_METRIC_DEFINITIONS[key];
      expect(definition.length).toBeGreaterThan(20);
      expect(definition.length).toBeLessThanOrEqual(500);
    }
    expect(ADMIN_OVERVIEW_RANGE_PRESETS.map((preset) => preset.days)).toEqual([7, 30, 90, 365]);
    expect(
      matchingOverviewPreset(
        overviewRangeFromPreset(30, new Date("2026-10-07T12:00:00.000Z")).from,
        overviewRangeFromPreset(30, new Date("2026-10-07T12:00:00.000Z")).to,
        "2026-10-07T12:00:00.000Z",
      ),
    ).toBe("30d");
  });

  it("fills UTC day buckets and caps the series below the browser bound", () => {
    const series = fillUtcDaySeries(
      [{ key: "2026-10-02", value: 3 }],
      new Date("2026-10-01T12:00:00.000Z"),
      new Date("2026-10-04T12:00:00.000Z"),
    );
    expect(series).toEqual([
      { key: "2026-10-01", value: 0 },
      { key: "2026-10-02", value: 3 },
      { key: "2026-10-03", value: 0 },
      { key: "2026-10-04", value: 0 },
    ]);
    const wide = fillUtcDaySeries(
      [],
      new Date("2026-01-01T12:00:00.000Z"),
      new Date("2027-01-02T12:00:00.000Z"),
    );
    expect(wide.length).toBeGreaterThan(360);
    expect(wide.length).toBeLessThanOrEqual(ADMIN_CHART_SERIES_MAX);
    expect(
      AdminOverviewSchema.safeParse({
        asOf: "2026-10-07T12:00:00.000Z",
        range: { from: "2026-01-01T12:00:00.000Z", to: "2027-01-02T12:00:00.000Z" },
        currency: "USD",
        metrics: {
          newUsersByDay: {
            value: 0,
            availability: "available",
            reason: null,
            definition: ADMIN_METRIC_DEFINITIONS.newUsersByDay,
            series: wide,
          },
        },
        controls: {},
        warnings: [],
      }).success,
    ).toBe(true);
  });

  it("merges and ranks closed error categories without raw provider text", () => {
    expect(errorCategoryKey("PAY", "CARD_DECLINED")).toBe("PAY:CARD_DECLINED");
    expect(errorCategoryKey("WEBHOOK", "x".repeat(80)).length).toBeLessThanOrEqual(64);
    expect(
      topErrorCategories([
        { key: "AGENT:TIMEOUT", value: 2 },
        { key: "PAY:UNKNOWN", value: 5 },
        { key: "AGENT:TIMEOUT", value: 1 },
        { key: "REF:UNKNOWN", value: 5 },
      ]),
    ).toEqual([
      { key: "PAY:UNKNOWN", value: 5 },
      { key: "REF:UNKNOWN", value: 5 },
      { key: "AGENT:TIMEOUT", value: 3 },
    ]);
  });
});
