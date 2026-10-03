import { afterEach, describe, expect, it, vi } from "vitest";
import { createProposal, safeExternalUrl } from "./client";
import type { NormalizedProduct } from "./types";

describe("product source links", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allows only explicit HTTP(S) product URLs", () => {
    expect(safeExternalUrl("https://shop.example/products/headphones")).toBe(
      "https://shop.example/products/headphones",
    );
    expect(safeExternalUrl("http://demo.local/product")).toBe("http://demo.local/product");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });

  it("reuses a caller-owned request key when proposal creation is retried", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { id: "proposal_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal: { id: "proposal_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const product: NormalizedProduct = {
      source: "demo",
      externalId: "demo-headphones",
      title: "Demo headphones",
      brand: "Demo",
      category: "Headphones",
      condition: "NEW",
      priceMinor: 16_900,
      currency: "USD",
      merchant: "Demo Store",
      imageUrl: null,
      productUrl: null,
      checkoutEligible: true,
      demoSku: "sku-headphones",
    };

    await createProposal("mandate_1", product, "proposal-request-key");
    await createProposal("mandate_1", product, "proposal-request-key");

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.requestKey).toBe("proposal-request-key");
    expect(secondBody.requestKey).toBe("proposal-request-key");
  });
});
