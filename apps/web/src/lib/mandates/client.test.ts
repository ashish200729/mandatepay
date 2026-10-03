import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMandate } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("mandate parser HTTP contract", () => {
  it("reads the canonical mandate returned directly by the ready parser", async () => {
    const mandate = {
      title: "Headphones",
      productIntent: "headphones",
      currency: "USD",
      timezone: "UTC",
      allowedBrands: ["Sony"],
      blockedBrands: [],
      allowedCategories: [],
      blockedCategories: [],
      allowedConditions: ["NEW"],
      autoSpendLimit: 15000,
      transactionLimit: 18000,
      quantityLimit: 1,
      allowedMerchants: [],
      blockedMerchants: [],
      newMerchantRequiresApproval: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "ready", sourceOriginalPrompt: "Headphones", mandate }),
            { status: 200 },
          ),
      ),
    );
    const result = await parseMandate("Headphones");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready mandate");
    expect(result.mandate.transactionLimit).toBe(18000);
    expect(result.mandate.allowedBrands).toEqual(["Sony"]);
  });
  it("keeps clarification separate from permissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "needs_clarification",
              sourceOriginalPrompt: "Headphones",
              clarification: "What is the maximum budget?",
              mandate: null,
            }),
            { status: 200 },
          ),
      ),
    );
    expect((await parseMandate("Headphones")).status).toBe("needs_clarification");
  });

  it("stops a stalled parse and returns an actionable timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const result = expect(parseMandate("New PlayStation 5 under $600 USD")).rejects.toMatchObject({
      status: 408,
      message: expect.stringContaining("took too long"),
    });
    await vi.advanceTimersByTimeAsync(65_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the timeout after a network failure so retry remains possible", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(parseMandate("Headphones")).rejects.toBeInstanceOf(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
