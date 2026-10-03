import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { OpenAIOutputError, OpenAIProviderError, ShoppingAgentError } from "@mandatepay/agent";
import type { DatabaseClient } from "@mandatepay/database";
import { registerShoppingAgentRoutes } from "./agent.js";
import { Channel3Client, parseChannel3Config } from "@mandatepay/channel3";
import { registerCatalogRoutes } from "./catalog.js";
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
      database: { mandate: { findMany: async () => [] } } as unknown as DatabaseClient,
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
