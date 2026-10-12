import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIConfigurationError,
  OpenAIOutputError,
  OpenAIProviderError,
  ShoppingAgentError,
} from "@mandatepay/agent";
import type { DatabaseClient } from "@mandatepay/database";
import { registerShoppingAgentRoutes } from "./agent.js";
import { Channel3Client, parseChannel3Config } from "@mandatepay/channel3";
import {
  channel3FallbackMode,
  createChannel3CatalogClient,
  perMinuteLimit,
  registerCatalogRoutes,
} from "./catalog.js";
import { toMinorUnits } from "@mandatepay/shared";

describe("shopping failure responses", () => {
  it.each([
    [new OpenAIProviderError("UPSTREAM_TIMEOUT"), 504, "SHOPPING_TIMEOUT"],
    [
      new OpenAIProviderError("UPSTREAM_UNAVAILABLE", 503, "private provider body"),
      503,
      "SHOPPING_AI_UNAVAILABLE",
    ],
    [
      new OpenAIProviderError("UPSTREAM_REQUEST_FAILED", 400, "private tool schema body"),
      503,
      "SHOPPING_AI_UNAVAILABLE",
    ],
    [new OpenAIOutputError("MALFORMED_OUTPUT"), 502, "SHOPPING_AI_RESPONSE_INVALID"],
    [new ShoppingAgentError("MODEL_RESPONSE_INVALID"), 502, "SHOPPING_AI_RESPONSE_INVALID"],
    [new ShoppingAgentError("TOOL_TIMEOUT", "search_products"), 504, "SHOPPING_TIMEOUT"],
    [
      new ShoppingAgentError("TOOL_HANDLER_FAILED", "compare_products"),
      503,
      "SHOPPING_TOOLS_UNAVAILABLE",
    ],
  ] as const)("returns safe guidance for %s", async (cause, status, code) => {
    const app = Fastify();
    registerShoppingAgentRoutes(app, {
      app,
      database: {
        mandate: { findMany: async () => [] },
        platformSetting: { findMany: async () => [] },
      } as unknown as DatabaseClient,
      appUrl: "http://127.0.0.1:3000",
      requireUser: async () => ({ id: "fixture-user" }),
      isTrustedOrigin: () => true,
      runner: async () => {
        throw cause;
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/chat",
        payload: { message: "Show shoe varieties", requestKey: "same-request-key" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        code,
        error: expect.stringContaining("Retry the same request"),
      });
      expect(response.body).not.toContain("private");
    } finally {
      await app.close();
    }
  });
});

function minimalChatApp(options: {
  runner: Parameters<typeof registerShoppingAgentRoutes>[1]["runner"];
  chatRateLimitPerMinute?: number;
}) {
  const app = Fastify();
  registerShoppingAgentRoutes(app, {
    app,
    database: {
      mandate: { findMany: async () => [] },
      platformSetting: { findMany: async () => [] },
      agentRun: { create: async () => ({}) },
    } as unknown as DatabaseClient,
    appUrl: "http://127.0.0.1:3000",
    requireUser: async () => ({ id: "fixture-user" }),
    isTrustedOrigin: () => true,
    runner: options.runner,
    chatRateLimitPerMinute: options.chatRateLimitPerMinute,
  });
  return app;
}

describe("shopping configuration", () => {
  it("explains a missing AI configuration as 503 instead of an unreadable response", async () => {
    const app = minimalChatApp({
      runner: async () => {
        throw new OpenAIConfigurationError("MISSING_API_KEY");
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/chat",
        payload: { message: "Find headphones", requestKey: "config-request" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "SHOPPING_AI_NOT_CONFIGURED",
        error: expect.stringContaining("AI service is not configured"),
      });
    } finally {
      await app.close();
    }
  });

  it("applies the configured per-user chat rate limit", async () => {
    const runner = vi.fn(async () => {
      throw new OpenAIProviderError("UPSTREAM_UNAVAILABLE");
    });
    const app = minimalChatApp({ runner, chatRateLimitPerMinute: 2 });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/agent/chat",
          payload: { message: "Find headphones", requestKey: `rate-${index}` },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([503, 503, 429]);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("parses per-minute limits safely with defaults", () => {
    expect(perMinuteLimit(undefined, 12)).toBe(12);
    expect(perMinuteLimit("30", 12)).toBe(30);
    expect(perMinuteLimit(" 8 ", 12)).toBe(8);
    for (const invalid of ["0", "-1", "1.5", "1e3", "abc", "", "1001"]) {
      expect(perMinuteLimit(invalid, 10)).toBe(10);
    }
    expect(channel3FallbackMode("demo")).toBe("demo");
    expect(channel3FallbackMode(" DEMO ")).toBe("demo");
    expect(channel3FallbackMode(undefined)).toBe("disabled");
    expect(channel3FallbackMode("live")).toBe("disabled");
    expect(createChannel3CatalogClient(undefined)).toBeUndefined();
    expect(
      createChannel3CatalogClient("fixture-key", { CHANNEL3_TIMEOUT_MS: "nope" })?.config,
    ).toMatchObject({ fallbackMode: "disabled", timeoutMs: 15_000 });
  });
});

describe("Channel3 demo fallback", () => {
  const now = Date.now();
  const rules = {
    title: "Headphones",
    productIntent: "noise cancelling headphones",
    currency: "USD",
    timezone: "UTC",
    allowedBrands: ["Sony", "Bose"],
    blockedBrands: [],
    allowedCategories: [],
    blockedCategories: [],
    allowedConditions: ["NEW"],
    autoSpendLimit: 15_000,
    transactionLimit: 18_000,
    quantityLimit: 1,
    allowedMerchants: [],
    blockedMerchants: [],
    newMerchantRequiresApproval: false,
    startsAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  };
  function catalogApp(options: {
    fallback?: "demo" | "disabled";
    channel3?: Channel3Client;
    compareRateLimitPerMinute?: number;
    rank?: () => Promise<unknown>;
  }) {
    const app = Fastify();
    const audit = vi.fn(async () => ({}));
    registerCatalogRoutes(app, {
      database: {
        mandate: {
          findFirst: async () => ({
            id: "mandate",
            status: "ACTIVE",
            title: rules.title,
            startsAt: new Date(rules.startsAt),
            expiresAt: new Date(rules.expiresAt),
            activeVersion: { canonicalRules: rules, version: 1 },
          }),
        },
        auditEvent: { create: audit },
        platformSetting: { findMany: async () => [] },
      } as unknown as DatabaseClient,
      requireUser: async () => ({ id: "fixture-user" }),
      isTrustedOrigin: () => true,
      mode: "channel3",
      channel3: options.channel3,
      channel3Fallback: options.fallback,
      compareRateLimitPerMinute: options.compareRateLimitPerMinute,
      rank: options.rank ?? (async () => ({ recommendations: [] })),
    });
    return { app, audit };
  }
  const failing = () =>
    new Channel3Client(parseChannel3Config({ apiKey: "fixture-key", maxRetries: 0 }), {
      fetch: async () => new Response("unavailable", { status: 503 }),
    });

  it("serves labeled Demo Catalog results when Channel3 fails and fallback is enabled", async () => {
    const { app, audit } = catalogApp({ fallback: "demo", channel3: failing() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/products/search",
        payload: { mandateId: "mandate", query: "wireless headphones" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ mode: "demo", fallback: true });
      expect(body.notice).toContain("Demo Catalog fallback");
      expect(body.products.length).toBeGreaterThan(0);
      expect(body.products.every((product: { source: string }) => product.source === "demo")).toBe(
        true,
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({ fallback: "channel3_unavailable" }),
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("serves the fallback when no Channel3 client is configured", async () => {
    const { app } = catalogApp({ fallback: "demo" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/products/search",
        payload: { mandateId: "mandate", query: "ANC headphones" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().fallback).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("keeps the 503 when fallback is disabled", async () => {
    const { app } = catalogApp({ fallback: "disabled", channel3: failing() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/products/search",
        payload: { mandateId: "mandate", query: "headphones" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("PRODUCT_SERVICE_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });

  it("explains a missing AI configuration when comparing", async () => {
    const { app } = catalogApp({
      rank: async () => {
        throw new OpenAIConfigurationError("MISSING_API_KEY");
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/products/compare",
        payload: {
          mandateId: "mandate",
          products: [{ source: "demo", externalId: "demo-headphones-139" }],
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "AI_NOT_CONFIGURED" });
      expect(response.json().error).toContain("AI service is not configured");
    } finally {
      await app.close();
    }
  });

  it("applies the configured per-user compare rate limit", async () => {
    const { app } = catalogApp({ fallback: "demo", compareRateLimitPerMinute: 1 });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 2; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/products/compare",
          payload: {
            mandateId: "mandate",
            products: [{ source: "demo", externalId: "demo-headphones-139" }],
          },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([200, 429]);
    } finally {
      await app.close();
    }
  });
});

describe("shopping chat through the catalog route", () => {
  it.each([
    [null, ["nike-cheap", "nike-result", "nike-at-limit"], false],
    [20_000, ["nike-cheap", "nike-result", "nike-at-limit"], false],
    [5_000, ["nike-cheap"], false],
    [0, [], false],
    [10_000, ["nike-cheap", "nike-result", "nike-at-limit"], true],
  ] as const)(
    "uses the saved budget when the model supplies %s",
    async (modelMaximum, expectedIds, comparison) => {
      const app = Fastify();
      const now = Date.now();
      const rules = {
        title: "Nike shoes",
        productIntent: "Nike shoes",
        currency: "USD",
        timezone: "UTC",
        allowedBrands: ["Nike"],
        blockedBrands: [],
        allowedCategories: ["shoes"],
        blockedCategories: ["sandals"],
        allowedConditions: ["NEW"],
        autoSpendLimit: 0,
        transactionLimit: 10_000,
        quantityLimit: 1,
        allowedMerchants: [],
        blockedMerchants: [],
        newMerchantRequiresApproval: false,
        startsAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
      };
      const audit = vi.fn(async () => ({}));
      const database = {
        mandate: {
          findFirst: async () => ({
            id: "nike-mandate",
            status: "ACTIVE",
            title: rules.title,
            startsAt: new Date(rules.startsAt),
            expiresAt: new Date(rules.expiresAt),
            activeVersion: { canonicalRules: rules, version: 1 },
          }),
        },
        auditEvent: { create: audit },
        platformSetting: { findMany: async () => [] },
      } as unknown as DatabaseClient;
      const origin = "http://localhost:3000";
      const requireUser = vi.fn(async (request, reply) => {
        if (request.headers.cookie !== "fixture-session=owner") {
          reply.status(401).send({ error: "Unauthorized" });
          return null;
        }
        return { id: "fixture-user" };
      });
      const context = {
        database,
        requireUser,
        isTrustedOrigin: (value: string | undefined) => value === origin,
      };
      registerCatalogRoutes(app, {
        ...context,
        mode: "channel3",
        rank: async () => ({}),
        channel3: new Channel3Client(parseChannel3Config({ apiKey: "fixture-key" }), {
          fetch: async (_input, init) => {
            expect(JSON.parse(String(init?.body)).query).toBe("Nike shoes");
            return Response.json({
              products: [
                {
                  id: "blocked-child",
                  title: "Nike sandals",
                  brands: [{ name: "Nike" }],
                  category: { title: "Sandals", path: [{ title: "Shoes" }, { title: "Sandals" }] },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 10, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "wrong-category",
                  title: "Nike apparel",
                  brands: [{ name: "Nike" }],
                  category: { title: "Apparel" },
                  metadata: { categoryPath: ["Shoes"] },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 10, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "nike-cheap",
                  title: "Nike budget shoes",
                  brands: [{ name: "Nike" }],
                  category: {
                    title: "Sneakers",
                    path: [
                      { title: "Shoes", slug: "shoes" },
                      { title: "Sneakers", slug: "sneakers" },
                    ],
                  },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 49.99, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "nike-at-limit",
                  title: "Nike limit shoes",
                  brands: [{ name: "Nike" }],
                  category: {
                    title: "Sneakers",
                    path: [
                      { title: "Shoes", slug: "shoes" },
                      { title: "Sneakers", slug: "sneakers" },
                    ],
                  },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 100, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "nike-over-limit",
                  title: "Nike expensive shoes",
                  brands: [{ name: "Nike" }],
                  category: { title: "Shoes" },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 100.01, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "wrong-brand",
                  title: "Other brand shoes",
                  brands: [{ name: "Other" }],
                  category: { title: "Shoes" },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 10, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "used-shoes",
                  title: "Nike used shoes",
                  brands: [{ name: "Nike" }],
                  category: { title: "Shoes" },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "used",
                      price: { price: 10, currency: "USD" },
                    },
                  ],
                },
                {
                  id: "nike-result",
                  title: "Nike running shoes",
                  brands: [{ name: "Nike" }],
                  category: { slug: "shoes", title: "Shoes" },
                  offers: [
                    {
                      domain: "retailer.example.test",
                      condition: "new",
                      price: { price: 66.99, currency: "USD" },
                    },
                  ],
                },
              ],
            });
          },
        }),
      });
      registerShoppingAgentRoutes(app, {
        ...context,
        app,
        appUrl: origin,
        runner: async (_input, tools) => {
          const context = await tools.get_active_mandates?.(
            {},
            { signal: new AbortController().signal },
          );
          expect(context).toMatchObject({
            mandates: [
              {
                rules: { transactionLimit: 10_000, autoSpendLimit: 0 },
                budget: {
                  maximumTotal: "$100.00 USD",
                  automaticLimit: "$0.00 USD",
                  approval: expect.stringContaining("Ask before every purchase"),
                },
              },
            ],
          });
          const result = await tools.search_products?.(
            {
              query: "shoes",
              maximumPriceMinor: modelMaximum === null ? null : toMinorUnits(modelMaximum),
              brands: [],
              category: "Shoes",
            },
            { signal: new AbortController().signal },
          );
          const products = (result as { products: { externalId: string }[] }).products;
          expect(products.map((product) => product.externalId).sort()).toEqual(
            [...expectedIds].sort(),
          );
          if (comparison)
            await tools.compare_products?.(
              { productIds: [...expectedIds].slice(0, 2) },
              { signal: new AbortController().signal },
            );
          return {
            status: "completed",
            rounds: 1,
            trace: [],
            finalAIExplanation: {
              kind: "explanation",
              text: "Your mandate doesn’t specify a budget ceiling.",
              paymentAuthoritative: false,
            },
          };
        },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/agent/chat",
          headers: { origin, cookie: "fixture-session=owner" },
          payload: {
            message: "check the products related to this",
            mandateId: "nike-mandate",
            requestKey: "nike-search",
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          explanation: null,
          proposals: [],
          steps: [
            { name: "get_active_mandates", status: "completed" },
            { name: "search_products", status: "completed" },
            ...(comparison ? [{ name: "compare_products", status: "completed" }] : []),
          ],
        });
        expect(response.json().message).toContain("$100.00 USD");
        expect(response.json().message).toContain("approval is required before every purchase");
        expect(response.json().message).not.toContain("doesn’t specify");
        expect(response.json().message).not.toContain("expensive shoes");
        if (expectedIds.length) expect(response.json().message).toContain("budget shoes");
        else expect(response.json().message).toContain("couldn’t find products matching");
        if (comparison) {
          expect(response.json().message).toContain(
            "| Product | Listed price | Retailer | Condition |",
          );
          expect(response.json().message).not.toContain("Nike limit shoes");
        }
        expect(requireUser).toHaveBeenCalledTimes(2);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ eventType: "PRODUCT_SEARCH_COMPLETED" }),
          }),
        );
      } finally {
        await app.close();
      }
    },
  );
});
