import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardSummary, getDashboardTransactions, queryDashboard } from "./client";

const transaction = {
  id: "tx-1",
  paymentId: "payment-1",
  createdAt: "2026-10-02T12:00:00Z",
  capturedAt: "2026-10-03T12:00:00Z",
  activityAt: "2026-10-03T12:00:00Z",
  product: { title: "Paper", brand: "Demo", condition: "NEW" },
  merchant: "Demo Store",
  category: "Office",
  amountMinor: 2_700,
  currency: "USD",
  mandate: { title: "Office supplies", version: 1 },
  decision: "ALLOW",
  approvalType: "AUTO_APPROVED",
  paypalStatus: "COMPLETED",
};

describe("analytics client DTOs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads verified summary totals and cursor transactions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            totals: {
              purchases: 1,
              policyAllowed: 1,
              humanApproved: 0,
              blocked: 0,
              spendMinor: 2_700,
              refundsMinor: 0,
              activeMandates: 1,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [transaction], nextCursor: "cursor-1" }), {
          status: 200,
        }),
      );

    await expect(getDashboardSummary()).resolves.toMatchObject({ spendMinor: 2_700, purchases: 1 });
    await expect(
      getDashboardTransactions({
        minAmountMinor: 2_000,
        minAmountExclusive: true,
        decision: "ALLOW",
      }),
    ).resolves.toEqual({ transactions: [transaction], nextCursor: "cursor-1" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("minAmountMinor=2000");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("minAmountExclusive=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("decision=ALLOW");
  });

  it("preserves clarification state from natural-language queries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "needs_clarification",
          clarification: "Which time range should I use?",
          filters: null,
        }),
        { status: 200 },
      ),
    );
    await expect(queryDashboard("show blocked items")).resolves.toEqual({
      status: "needs_clarification",
      clarification: "Which time range should I use?",
      filters: null,
    });
  });
});
