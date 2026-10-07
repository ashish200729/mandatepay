import { describe, expect, it } from "vitest";
import { chartRecordHref, queryPath, utcDayBounds } from "./chart-hrefs";

const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" };

describe("dashboard chart drill-down links", () => {
  it("maps series keys onto filtered list pages without inventing extra query keys", () => {
    expect(utcDayBounds("2026-10-02")).toEqual({
      from: "2026-10-02T00:00:00.000Z",
      to: "2026-10-03T00:00:00.000Z",
    });
    expect(chartRecordHref("newUsersByDay", "2026-10-02", range)).toBe(
      "/users?from=2026-10-02T00%3A00%3A00.000Z&to=2026-10-03T00%3A00%3A00.000Z",
    );
    expect(chartRecordHref("capturedGrossByDay", "2026-10-02", range)).toContain(
      "dateBasis=captured",
    );
    expect(chartRecordHref("refundsByDay", "2026-10-02", range)).toContain("dateBasis=settled");
    expect(chartRecordHref("policyDistribution", "REQUIRE_APPROVAL", range)).toBe(
      queryPath("/proposals", { ...range, decision: "REQUIRE_APPROVAL" }),
    );
    expect(chartRecordHref("approvalFunnel", "APPROVED", range)).toBe(
      "/approvals?decision=APPROVED",
    );
    expect(chartRecordHref("checkoutFunnel", "CAPTURED", range)).toContain("dateBasis=captured");
    expect(chartRecordHref("mandateStatusDistribution", "EFFECTIVELY_EXPIRED", range)).toBe(
      "/mandates?effectiveExpired=true",
    );
    expect(chartRecordHref("topErrorCategories", "AGENT:TIMEOUT", range)).toContain(
      "errorClass=TIMEOUT",
    );
    expect(chartRecordHref("topErrorCategories", "WEBHOOK:WEBHOOK_TIMEOUT", range)).toContain(
      "/webhooks",
    );
  });
});
