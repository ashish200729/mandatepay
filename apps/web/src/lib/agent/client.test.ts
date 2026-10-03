import { afterEach, describe, expect, it, vi } from "vitest";
import { sendShoppingMessage } from "./client";

describe("shopping agent client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("forwards only the server-issued product reference and preserves it on retry", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        message: "External checkout is unsupported.",
        explanation: null,
        proposals: [],
        refundDraft: null,
        steps: [],
        productContext: "verified-products",
      }),
    );
    const response = await sendShoppingMessage(
      "Get this",
      "mandate_1",
      "same-key",
      "verified-products",
    );
    await sendShoppingMessage("Get this", "mandate_1", "same-key", "verified-products");
    expect(response.productContext).toBe("verified-products");
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string))).toEqual([
      {
        message: "Get this",
        mandateId: "mandate_1",
        requestKey: "same-key",
        productContext: "verified-products",
      },
      {
        message: "Get this",
        mandateId: "mandate_1",
        requestKey: "same-key",
        productContext: "verified-products",
      },
    ]);
  });

  it("keeps the expired-selection code so the browser can ask for a new search", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          code: "SHOPPING_SELECTION_EXPIRED",
          error: "Search again to choose a current product.",
        },
        { status: 409 },
      ),
    );
    await expect(
      sendShoppingMessage("Get this", "mandate_1", "key", "expired"),
    ).rejects.toMatchObject({
      status: 409,
      code: "SHOPPING_SELECTION_EXPIRED",
    });
  });

  it("ends a stalled chat with useful guidance and preserves the same key on retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const response = expect(
      sendShoppingMessage("Show shoes", "mandate_1", "stable-request-key"),
    ).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("Retry the same request"),
    });
    await vi.advanceTimersByTimeAsync(135_000);
    await response;
    fetch.mockResolvedValue(
      Response.json({
        message: "Available options",
        explanation: null,
        steps: [],
        proposals: [],
        refundDraft: null,
      }),
    );
    await sendShoppingMessage("Show shoes", "mandate_1", "stable-request-key");
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string).requestKey)).toEqual([
      "stable-request-key",
      "stable-request-key",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explains a connection failure without exposing transport details", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("private transport detail"));
    await expect(sendShoppingMessage("Show shoes", undefined, "request_1")).rejects.toMatchObject({
      status: 503,
      message:
        "We couldn’t connect to the shopping assistant. Check your connection, then retry the same request.",
    });
  });

  it("reads server steps, policy proposals, and refund drafts without making payment claims", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "I found a match and prepared a proposal for review.",
          explanation: {
            kind: "explanation",
            text: "The product matched the mandate.",
            paymentAuthoritative: false,
          },
          steps: [{ name: "search_products", status: "completed" }],
          proposals: [
            {
              proposal: {
                id: "proposal_1",
                status: "AWAITING_APPROVAL",
                total: 16_900,
                shipping: 0,
                tax: 0,
                currency: "USD",
                expiresAt: null,
                approvalExpiresAt: "2026-10-03T12:00:00Z",
                product: {
                  title: "Demo headphones",
                  brand: "Demo",
                  condition: "NEW",
                  merchant: "Demo Store",
                  source: "demo",
                },
                mandate: { title: "Headphones", version: 1 },
              },
              decision: {
                decision: "REQUIRE_APPROVAL",
                reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
              },
            },
          ],
          refundDraft: {
            paymentId: "payment_1",
            amountMinor: null,
            reason: "Damaged",
            reviewUrl: "/orders/payment_1",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await sendShoppingMessage("Find headphones", "mandate_1", "request_1");
    expect(result.proposals[0]?.decision?.decision).toBe("REQUIRE_APPROVAL");
    expect(result.steps[0]?.name).toBe("search_products");
    expect(result.refundDraft?.reviewUrl).toBe("/orders/payment_1");
    expect(result.explanation?.paymentAuthoritative).toBe(false);
  });

  it("omits the mandate for refund requests and keeps the exact retry key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Please identify the captured order.",
          explanation: null,
          steps: [],
          proposals: [],
          refundDraft: null,
        }),
      ),
    );
    await sendShoppingMessage("Refund my order", "", "same-request-key");
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      message: "Refund my order",
      requestKey: "same-request-key",
    });
  });

  it("allows an absent brand from the real proposal DTO", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Prepared.",
          explanation: null,
          steps: [],
          refundDraft: null,
          proposals: [
            {
              proposal: {
                id: "proposal_1",
                status: "AUTHORIZED",
                total: 1000,
                shipping: 0,
                tax: 0,
                currency: "USD",
                expiresAt: null,
                approvalExpiresAt: null,
                product: {
                  title: "Item",
                  brand: null,
                  condition: "NEW",
                  merchant: "Store",
                  source: "demo",
                },
                mandate: { title: "Items", version: 1 },
              },
              decision: { decision: "ALLOW", reasonCodes: [] },
            },
          ],
        }),
      ),
    );
    expect(
      (await sendShoppingMessage("Find an item", "mandate_1", "request_1")).proposals[0]?.product
        .brand,
    ).toBeNull();
  });

  it("rejects an invented policy decision", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Prepared.",
          explanation: null,
          steps: [],
          refundDraft: null,
          proposals: [
            {
              proposal: { product: { source: "demo", condition: "NEW" }, mandate: { version: 1 } },
              decision: { decision: "PAYMENT_COMPLETED", reasonCodes: [] },
            },
          ],
        }),
      ),
    );
    await expect(sendShoppingMessage("Find an item", "mandate_1", "request_1")).rejects.toThrow(
      "decision",
    );
  });

  it("rejects a refund redirect outside the owned order route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Review.",
          explanation: null,
          steps: [],
          proposals: [],
          refundDraft: {
            paymentId: "payment_1",
            amountMinor: 2000,
            reason: "Damaged",
            reviewUrl: "https://attacker.test",
          },
        }),
      ),
    );
    await expect(sendShoppingMessage("Refund my order", undefined, "request_1")).rejects.toThrow(
      "destination",
    );
  });
});
