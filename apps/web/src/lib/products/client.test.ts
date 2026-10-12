import { afterEach, describe, expect, it, vi } from "vitest";
import { createProposal, evaluateProposal, safeExternalUrl, searchProducts } from "./client";
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

describe("discovery policy copy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows verdict-specific copy instead of raw reason codes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        proposal: { id: "proposal_2", status: "BLOCKED", total: 12_000, currency: "USD" },
        decision: { decision: "BLOCK", reasonCodes: ["CONDITION_NOT_ALLOWED"] },
      }),
    );
    const proposal = await evaluateProposal("proposal_2");
    expect(proposal.policyReason).toBe(
      "Blocked by your mandate — Your mandate doesn’t allow this product condition",
    );
    expect(proposal.policyReason).not.toContain("CONDITION_NOT_ALLOWED");
    expect(proposal.policy?.decision).toBe("BLOCK");
  });

  it("prefers the server explanation and reports Demo Catalog fallback", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          proposal: { id: "proposal_3", status: "AUTHORIZED" },
          decision: {
            decision: "ALLOW",
            reasonCodes: [],
            explanation: {
              decision: "ALLOW",
              headline: "Within your mandate — $139 is under your $150 automatic limit",
              summary: "AgentGuard allowed this purchase without asking you.",
              approvalCanOverride: true,
              checks: [],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          products: [],
          mode: "demo",
          notice: "Demo Catalog fallback",
          fallback: true,
        }),
      );
    expect((await evaluateProposal("proposal_3")).policyReason).toBe(
      "Within your mandate — $139 is under your $150 automatic limit",
    );
    expect(await searchProducts("mandate_1", "headphones")).toMatchObject({ fallback: true });
  });
});
