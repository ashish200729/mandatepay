import { describe, expect, it } from "vitest";
import {
  Channel3Client,
  Channel3NormalizationError,
  Channel3ProviderError,
  DEMO_CATALOG,
  NormalizedProductSchema,
  loadChannel3Config,
  lookupDemoProduct,
  normalizeProduct,
  parseChannel3Config,
  searchDemoCatalog,
  snapshotProduct,
} from "../src/index.js";

const productPayload = {
  id: "channel3-sony-xm5",
  title: "Sony WH-1000XM5 Noise Cancelling Headphones",
  brand: "Sony",
  category: "Headphones",
  condition: "NEW",
  price: { amount: "169.00", currency: "USD" },
  merchant: "Example Merchant",
  image_url: "https://images.example.test/xm5.jpg",
  product_url: "https://merchant.example.test/xm5",
  metadata: { sourceRank: 1, nested: { verified: true } },
};

// Provider's canonical search shape, including nested offer price and category title.
const canonicalProduct = {
  id: "fixture-nike-shoes",
  title: "Nike running shoes",
  brands: [{ id: "fixture-nike", name: "Nike" }],
  category: {
    slug: "sneakers",
    title: "Sneakers",
    path: [
      { slug: "shoes", title: "Shoes" },
      { slug: "sneakers", title: "Sneakers" },
    ],
  },
  images: [
    { url: "https://images.example.test/side.jpg", is_main_image: false },
    { url: "https://images.example.test/main.jpg", is_main_image: true },
  ],
  offers: [
    {
      domain: "retailer.example.test",
      url: "https://retailer.example.test/shoes",
      price: { price: 66.99, compare_at_price: 80, currency: "USD" },
      condition: "new",
      availability: "InStock",
    },
    {
      domain: "another.example.test",
      url: "https://another.example.test/shoes",
      price: { price: 40, currency: "USD" },
      condition: "used",
      availability: "InStock",
    },
  ],
};

function config(overrides: Record<string, unknown> = {}) {
  return parseChannel3Config({
    apiKey: "channel3-test-secret",
    baseURL: "https://api.trychannel3.com/v1",
    maxRetries: 0,
    timeoutMs: 1_000,
    ...overrides,
  });
}

function mockFetch(payload: unknown, status = 200) {
  let requestUrl: string | undefined;
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    if (typeof init?.body === "string")
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      JSON.stringify(status >= 400 ? { error: { message: "raw upstream body" } } : payload),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  };

  return {
    fetcher,
    get requestUrl() {
      return requestUrl;
    },
    get requestHeaders() {
      return requestHeaders;
    },
    get requestBody() {
      return requestBody;
    },
  };
}

describe("Channel3 discovery client", () => {
  it("reads canonical brands, images and retailer offers without mixing their facts", async () => {
    const transport = mockFetch({ products: [canonicalProduct], next_page_token: null });
    const client = new Channel3Client(config(), { fetch: transport.fetcher });
    const products = await client.searchProducts({ query: "Nike shoes" });
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      externalId: "fixture-nike-shoes",
      brand: "Nike",
      category: "Sneakers",
      metadata: { categoryPath: ["Shoes", "shoes", "Sneakers", "sneakers"] },
      condition: "NEW",
      priceMinor: 6_699,
      currency: "USD",
      merchant: "retailer.example.test",
      productUrl: "https://retailer.example.test/shoes",
      imageUrl: "https://images.example.test/main.jpg",
      source: "channel3",
      checkoutEligible: false,
      demoSku: null,
    });
  });

  it.each([
    [{ ...canonicalProduct, brands: [] }, "INCOMPLETE_PRODUCT"],
    [{ ...canonicalProduct, offers: [] }, "INCOMPLETE_PRODUCT"],
    [
      { ...canonicalProduct, offers: [{ ...canonicalProduct.offers[0], domain: null }] },
      "INCOMPLETE_PRODUCT",
    ],
    [
      { ...canonicalProduct, offers: [{ ...canonicalProduct.offers[0], condition: null }] },
      "INCOMPLETE_PRODUCT",
    ],
    [
      {
        ...canonicalProduct,
        offers: [{ ...canonicalProduct.offers[0], price: { price: -1, currency: "USD" } }],
      },
      "INVALID_PRICE",
    ],
    [
      {
        ...canonicalProduct,
        offers: [{ ...canonicalProduct.offers[0], price: { price: 10, currency: "EUR" } }],
      },
      "UNSUPPORTED_CURRENCY",
    ],
  ] as const)("still rejects incomplete or unsupported canonical data", (raw, code) => {
    expect(() => normalizeProduct(raw)).toThrowError(expect.objectContaining({ code }));
  });

  it("takes category ancestry only from the provider taxonomy, not arbitrary metadata", () => {
    const product = normalizeProduct({
      ...canonicalProduct,
      category: { title: "Apparel" },
      metadata: { categoryPath: ["Shoes"] },
    });
    expect(product.category).toBe("Apparel");
    expect(product.metadata.categoryPath).toEqual([]);
  });

  it("searches the documented endpoint and normalizes USD prices to integer cents", async () => {
    const transport = mockFetch({ products: [productPayload] });
    const client = new Channel3Client(config(), { fetch: transport.fetcher });

    const products = await client.searchProducts({
      query: "Sony noise cancelling headphones",
      limit: 5,
      filters: { brand: "Sony" },
    });

    expect(transport.requestUrl).toBe("https://api.trychannel3.com/v1/search");
    expect(transport.requestHeaders?.get("x-api-key")).toBe("channel3-test-secret");
    expect(transport.requestBody).toEqual({
      query: "Sony noise cancelling headphones",
      limit: 5,
      filters: { brand: "Sony" },
    });
    expect(products[0]).toMatchObject({
      source: "channel3",
      externalId: "channel3-sony-xm5",
      priceMinor: 16_900,
      currency: "USD",
      checkoutEligible: false,
      demoSku: null,
    });
    expect(NormalizedProductSchema.safeParse(products[0]).success).toBe(true);
  });

  it("looks up a product separately from search", async () => {
    const transport = mockFetch({ product: productPayload });
    const client = new Channel3Client(config(), { fetch: transport.fetcher });

    const product = await client.lookupProduct({ url: "https://merchant.example.test/xm5" });

    expect(transport.requestUrl).toBe("https://api.trychannel3.com/v1/lookup");
    expect(transport.requestBody).toEqual({ url: "https://merchant.example.test/xm5" });
    expect(product.externalId).toBe("channel3-sony-xm5");
    expect(product.checkoutEligible).toBe(false);
  });

  it.each([
    ["price", { ...productPayload, price: undefined }, "INVALID_PRICE"],
    ["brand", { ...productPayload, brand: undefined }, "INCOMPLETE_PRODUCT"],
    ["condition", { ...productPayload, condition: undefined }, "INCOMPLETE_PRODUCT"],
    ["merchant", { ...productPayload, merchant: undefined }, "INCOMPLETE_PRODUCT"],
    [
      "currency",
      { ...productPayload, price: { amount: "10", currency: "EUR" } },
      "UNSUPPORTED_CURRENCY",
    ],
  ] as const)("fails closed when %s data is unusable", (_field, raw, code) => {
    expect(() => normalizeProduct(raw)).toThrowError(expect.objectContaining({ code }));
  });

  it("creates deeply immutable snapshots with an explicit capture timestamp", () => {
    const product = normalizeProduct(productPayload);
    const snapshot = snapshotProduct(product, "2026-10-02T12:00:00Z");

    expect(snapshot.capturedAt).toBe("2026-10-02T12:00:00Z");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metadata)).toBe(true);
    expect(Object.isFrozen((snapshot.metadata as { nested: object }).nested)).toBe(true);
  });

  it("enforces checkout eligibility rules on snapshots too", () => {
    const external = normalizeProduct(productPayload);
    expect(() =>
      snapshotProduct(
        { ...external, checkoutEligible: true, demoSku: "forged-demo-sku" },
        "2026-10-02T12:00:00Z",
      ),
    ).toThrowError();
  });

  it("keeps demo checkout eligibility distinct from external discovery", () => {
    expect(DEMO_CATALOG.length).toBeGreaterThan(0);
    expect(DEMO_CATALOG.every((product) => product.source === "demo")).toBe(true);
    expect(
      DEMO_CATALOG.every((product) => product.checkoutEligible && product.demoSku !== null),
    ).toBe(true);

    const sony = searchDemoCatalog("Sony headphones");
    expect(sony.length).toBeGreaterThan(0);
    expect(sony[0]?.source).toBe("demo");
    expect(searchDemoCatalog("noise-cancelling headphones").length).toBeGreaterThan(0);
    expect(lookupDemoProduct("demo-sku-headphones-169")?.priceMinor).toBe(16_900);
  });

  it("rejects unsafe minor-price strings before numeric coercion", () => {
    for (const priceMinor of ["", "1e2", "0x10", "1.5", " 100 "]) {
      expect(() => normalizeProduct({ ...productPayload, price_minor: priceMinor })).toThrowError(
        expect.objectContaining({ code: "INVALID_PRICE" }),
      );
    }
  });

  it("requires HTTP(S) base URLs without credentials or query fragments", () => {
    for (const baseURL of [
      "file:///tmp/channel3",
      "https://user:pass@example.test/v1",
      "https://api.example.test/v1?token=secret",
      "https://api.example.test/v1#fragment",
    ]) {
      expect(() => parseChannel3Config({ apiKey: "key", baseURL })).toThrowError(
        expect.objectContaining({ code: "INVALID_BASE_URL" }),
      );
    }
  });

  it("uses demo fallback only when explicitly configured", async () => {
    let fetchCalls = 0;
    const fallbackClient = new Channel3Client(
      parseChannel3Config({ apiKey: null, fallbackMode: "demo" }),
      {
        fetch: async (...args) => {
          fetchCalls += 1;
          return fetch(...args);
        },
      },
    );
    const fallbackProducts = await fallbackClient.searchProducts({ query: "printer paper" });
    expect(fetchCalls).toBe(0);
    expect(fallbackProducts[0]?.source).toBe("demo");

    expect(() => loadChannel3Config({ CHANNEL3_FALLBACK_MODE: "disabled" })).toThrowError(
      expect.objectContaining({ code: "MISSING_API_KEY" }),
    );
  });

  it("does not claim live success when the provider fails unless demo fallback is enabled", async () => {
    const failedTransport = mockFetch({}, 503);
    const liveOnlyClient = new Channel3Client(config(), { fetch: failedTransport.fetcher });
    await expect(liveOnlyClient.searchProducts({ query: "headphones" })).rejects.toBeInstanceOf(
      Channel3ProviderError,
    );

    const fallbackTransport = mockFetch({}, 503);
    const fallbackClient = new Channel3Client(config({ fallbackMode: "demo" }), {
      fetch: fallbackTransport.fetcher,
    });
    const products = await fallbackClient.searchProducts({ query: "headphones" });
    expect(products[0]?.source).toBe("demo");
  });

  it("redacts provider bodies and API keys from typed errors", async () => {
    const transport = mockFetch({}, 500);
    const client = new Channel3Client(config(), { fetch: transport.fetcher });

    try {
      await client.searchProducts({ query: "headphones" });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Channel3ProviderError);
      expect(String(error)).not.toContain("channel3-test-secret");
      expect(String(error)).not.toContain("raw upstream body");
    }
  });

  it("rejects invalid lookup and search inputs", async () => {
    const client = new Channel3Client(config(), { fetch: mockFetch({}).fetcher });
    await expect(client.searchProducts({ query: "" })).rejects.toMatchObject({
      code: "INVALID_SEARCH_REQUEST",
    });
    await expect(client.lookupProduct({})).rejects.toMatchObject({
      code: "INVALID_LOOKUP_REQUEST",
    });
    await expect(
      client.lookupProduct({ url: "https://example.test", productId: "both" }),
    ).rejects.toMatchObject({
      code: "INVALID_LOOKUP_REQUEST",
    });
  });

  it("does not expose raw normalization errors as provider details", () => {
    try {
      normalizeProduct({ ...productPayload, brand: "" });
      throw new Error("expected normalization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Channel3NormalizationError);
      expect(String(error)).not.toContain("Sony");
    }
  });
});
