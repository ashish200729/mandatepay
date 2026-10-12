import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentStepLabel,
  createChatStreamParser,
  readAgentLiveStep,
  readExcludedProducts,
  safeProductImage,
  sendShoppingMessage,
  streamShoppingMessage,
  ShoppingAgentApiError,
} from "./client";

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

describe("shopping response helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads excluded listings with reasons and drops unsafe or malformed entries", () => {
    const listing = {
      externalId: "demo-headphones-refurbished",
      source: "demo",
      title: "Bose QuietComfort Refurbished Headphones",
      brand: "Bose",
      condition: "REFURBISHED",
      priceMinor: 12_000,
      merchant: "Mandate Demo Store",
      imageUrl: "/demo-products/over-ear-sand.svg",
      reasons: ["Your mandate allows new only; this one is refurbished."],
    };
    expect(
      readExcludedProducts([
        listing,
        { ...listing, externalId: "tracker", imageUrl: "https://tracker.example/x.svg" },
        { ...listing, reasons: [] },
        { ...listing, priceMinor: -1 },
        "not a product",
      ]),
    ).toEqual([
      { ...listing, promptInjection: false },
      { ...listing, externalId: "tracker", imageUrl: null, promptInjection: false },
    ]);
    expect(readExcludedProducts(undefined)).toEqual([]);
    expect(
      readExcludedProducts([
        { ...listing, promptInjection: true },
        { ...listing, promptInjection: "yes" },
      ]),
    ).toEqual([
      { ...listing, promptInjection: true },
      { ...listing, promptInjection: false },
    ]);
  });

  it("only allows same-origin demo illustrations", () => {
    expect(safeProductImage("/demo-products/over-ear-graphite.svg")).toBe(
      "/demo-products/over-ear-graphite.svg",
    );
    for (const unsafe of [
      "//evil.example/a.svg",
      "/demo-products/../secret.svg",
      "javascript:alert(1)",
      "https://cdn.example/a.svg",
      42,
    ])
      expect(safeProductImage(unsafe)).toBeNull();
  });

  it("labels server steps in plain language", () => {
    expect(agentStepLabel("search_products")).toBe("Searched the catalog");
    expect(agentStepLabel("create_purchase_proposal")).toBe(
      "Prepared a proposal and ran AgentGuard",
    );
    expect(agentStepLabel("some_new_tool")).toBe("Some new tool");
    expect(agentStepLabel("")).toBe("Server step");
  });

  it("keeps the server decision explanation on proposals and excluded listings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        message: "AgentGuard blocked it.",
        explanation: null,
        refundDraft: null,
        steps: [{ name: "create_purchase_proposal", status: "completed" }],
        excludedProducts: [],
        proposals: [
          {
            proposal: {
              id: "proposal-1",
              status: "BLOCKED",
              total: 22_000,
              shipping: 0,
              tax: 0,
              currency: "USD",
              expiresAt: null,
              approvalExpiresAt: null,
              product: {
                title: "Sony WH-1000XM5 + Travel Case Bundle",
                brand: "Sony",
                condition: "NEW",
                merchant: "Mandate Demo Store",
                source: "demo",
              },
              mandate: { title: "Headphones", version: 1 },
            },
            decision: {
              decision: "BLOCK",
              reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
              explanation: {
                decision: "BLOCK",
                headline: "Blocked by your mandate — $220 is above your $180 maximum per purchase",
                summary: "This is a hard rule, so approval can’t override it.",
                approvalCanOverride: false,
                checks: [
                  {
                    rule: "transaction_limit",
                    label: "Maximum per purchase",
                    status: "block",
                    limit: "$180",
                    actual: "$220",
                    message: "$220 is above your $180 maximum per purchase.",
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    const response = await sendShoppingMessage("Buy the bundle", "mandate_1", "key");
    expect(response.excludedProducts).toEqual([]);
    expect(response.proposals[0]?.decision?.explanation).toMatchObject({
      headline: "Blocked by your mandate — $220 is above your $180 maximum per purchase",
      approvalCanOverride: false,
      checks: [{ status: "block", limit: "$180", actual: "$220" }],
    });
  });
});

const streamResult = {
  message: "Options ready.",
  explanation: null,
  proposals: [],
  refundDraft: null,
  steps: [{ name: "search_products", status: "completed" }],
  excludedProducts: [],
  productContext: null,
};

function eventStream(chunks: string[], options: { fail?: boolean } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
        else if (options.fail) controller.error(new TypeError("network reset"));
        else controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("chat stream parser", () => {
  it("reassembles frames split across chunks and CRLF line endings and skips comments", () => {
    const events: { event: string; data: string }[] = [];
    const parser = createChatStreamParser((event) => events.push(event));
    parser.push(": stream-open\n\nevent: st");
    parser.push('ep\r\ndata: {"id":"mandate"');
    parser.push(',"label":"Reading","status":"running"}\r\n\r\nevent: result\ndata: {}');
    expect(events).toEqual([
      { event: "step", data: '{"id":"mandate","label":"Reading","status":"running"}' },
    ]);
    parser.end();
    expect(events.at(-1)).toEqual({ event: "result", data: "{}" });
  });

  it("accepts only well-formed server steps", () => {
    expect(
      readAgentLiveStep({ id: "catalog", label: "Searching the catalog", status: "running" }),
    ).toEqual({ id: "catalog", label: "Searching the catalog", status: "running" });
    expect(readAgentLiveStep({ id: "Catalog!", label: "x", status: "running" })).toBeNull();
    expect(readAgentLiveStep({ id: "catalog", label: " ", status: "running" })).toBeNull();
    expect(readAgentLiveStep({ id: "catalog", label: "x", status: "done" })).toBeNull();
    expect(readAgentLiveStep("step")).toBeNull();
  });
});

describe("streaming shopping client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports live steps and returns the same validated payload as the JSON endpoint", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        eventStream([
          ": stream-open\n\n",
          frame("step", { id: "mandate", label: "Reading your mandate", status: "running" }),
          frame("step", { id: "mandate", label: "Reading your mandate", status: "completed" }),
          frame("step", { id: "bad id", label: "ignored", status: "running" }),
          frame("result", streamResult),
        ]),
      );
    const steps: unknown[] = [];
    const response = await streamShoppingMessage(
      "Find headphones",
      "mandate_1",
      "key-1",
      undefined,
      (step) => steps.push(step),
    );
    expect(steps).toEqual([
      { id: "mandate", label: "Reading your mandate", status: "running" },
      { id: "mandate", label: "Reading your mandate", status: "completed" },
    ]);
    expect(response).toMatchObject({
      message: "Options ready.",
      proposals: [],
      productContext: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/agent/chat/stream");
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      message: "Find headphones",
      mandateId: "mandate_1",
      requestKey: "key-1",
    });
  });

  it("raises a streamed error event with its safe status and code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      eventStream([
        frame("step", { id: "outcome", label: "Request stopped", status: "failed" }),
        frame("error", {
          status: 504,
          code: "SHOPPING_TIMEOUT",
          error:
            "The shopping assistant took too long to respond. Retry the same request in a moment.",
        }),
      ]),
    );
    await expect(
      streamShoppingMessage("Find", "mandate_1", "key", undefined, () => undefined),
    ).rejects.toMatchObject({ status: 504, code: "SHOPPING_TIMEOUT" });
  });

  it("falls back to the JSON endpoint with the same request key when streaming fails before any event", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("stream blocked"))
      .mockResolvedValueOnce(Response.json(streamResult));
    const response = await streamShoppingMessage(
      "Find",
      "mandate_1",
      "same-key",
      "ctx",
      () => undefined,
    );
    expect(response.message).toBe("Options ready.");
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/agent/chat/stream",
      "/api/agent/chat",
    ]);
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({ requestKey: "same-key", productContext: "ctx" });
  });

  it.each([
    ["a missing stream route", () => Response.json({ error: "Not found" }, { status: 404 })],
    ["an empty stream", () => eventStream([": stream-open\n\n"])],
    ["a stream that breaks before any event", () => eventStream([], { fail: true })],
  ])("falls back for %s", async (_label, upstream) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(upstream())
      .mockResolvedValueOnce(Response.json(streamResult));
    await expect(
      streamShoppingMessage("Find", "mandate_1", "key", undefined, () => undefined),
    ).resolves.toMatchObject({ message: "Options ready." });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fall back once progress has arrived; it asks for a retry instead", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      eventStream([frame("step", { id: "catalog", label: "Searching", status: "running" })], {
        fail: true,
      }),
    );
    const failure = streamShoppingMessage("Find", "mandate_1", "key", undefined, () => undefined);
    await expect(failure).rejects.toBeInstanceOf(ShoppingAgentApiError);
    await expect(failure).rejects.toMatchObject({
      code: "SHOPPING_STREAM_INTERRUPTED",
      status: 503,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps JSON rejections from checks that run before the stream", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          code: "SHOPPING_SELECTION_EXPIRED",
          error: "Search again to choose a current product.",
        },
        { status: 409 },
      ),
    );
    await expect(
      streamShoppingMessage("Get this", "mandate_1", "key", "ctx", () => undefined),
    ).rejects.toMatchObject({ status: 409, code: "SHOPPING_SELECTION_EXPIRED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a JSON success from the stream URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(streamResult));
    await expect(
      streamShoppingMessage("Find", "mandate_1", "key", undefined, () => undefined),
    ).resolves.toMatchObject({ message: "Options ready." });
  });
});
