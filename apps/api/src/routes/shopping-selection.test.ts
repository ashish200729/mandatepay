import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@mandatepay/database";
import type { ShoppingAgentToolHandlers } from "@mandatepay/agent";
import { registerShoppingAgentRoutes } from "./agent.js";

const toolContext = { signal: new AbortController().signal };
const first = {
  source: "channel3",
  externalId: "pegasus-original",
  title: "M AIR PEGASUS 2005",
  brand: "Nike",
  category: "Sneakers",
  metadata: { categoryPath: ["Shoes"] },
  condition: "NEW",
  priceMinor: 4900,
  currency: "USD",
  merchant: "ka-yo.com",
  productUrl: "https://ka-yo.com/product/pegasus",
  checkoutEligible: false,
};
const finalResult = {
  status: "completed" as const,
  rounds: 1,
  trace: [],
  finalAIExplanation: {
    kind: "explanation" as const,
    text: "I bought it for you.",
    paymentAuthoritative: false as const,
  },
};
function fixture(options: { propose?: boolean; demo?: boolean; unsafeUrl?: boolean } = {}) {
  const app = Fastify();
  let userId = "owner";
  let version = 1;
  const product = {
    ...first,
    ...(options.demo ? { source: "demo" } : {}),
    ...(options.unsafeUrl ? { productUrl: "javascript:alert(1)" } : {}),
  };
  const search = vi.fn(async () => ({
    products: [
      product,
      {
        ...product,
        externalId: "other-price",
        title: "Other Nike sneakers",
        priceMinor: 1000,
        merchant: "dtlr.com",
        productUrl: "https://dtlr.com/other",
      },
    ],
  }));
  const create = vi.fn(async (_request, reply) =>
    reply.status(409).send({ error: "Product changed. Select a current product." }),
  );
  app.post("/api/products/search", search);
  app.post("/api/proposals", create);
  const database = {
    platformSetting: { findMany: async () => [] },
    mandate: {
      findFirst: async () => ({
        id: "nike-mandate",
        status: "ACTIVE",
        version,
        startsAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        activeVersion: {
          version,
          canonicalRules: {
            title: "Nike shoes",
            productIntent: "shoes",
            currency: "USD",
            timezone: "UTC",
            allowedBrands: ["Nike"],
            blockedBrands: [],
            allowedCategories: ["shoes"],
            blockedCategories: [],
            allowedConditions: ["NEW"],
            autoSpendLimit: 0,
            transactionLimit: 10000,
            quantityLimit: 1,
            allowedMerchants: [],
            blockedMerchants: [],
            newMerchantRequiresApproval: true,
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      }),
    },
  } as unknown as DatabaseClient;
  const runner = vi.fn(async (_input, tools: ShoppingAgentToolHandlers) => {
    await tools.get_active_mandates!({}, toolContext);
    await tools.search_products!(
      { query: "shoes", category: null, maximumPriceMinor: null, brands: [] },
      toolContext,
    );
    if (options.propose)
      await tools.create_purchase_proposal!(
        { productId: product.externalId, source: options.demo ? "demo" : "channel3", quantity: 1 },
        toolContext,
      );
    return finalResult;
  });
  registerShoppingAgentRoutes(app, {
    app,
    database,
    appUrl: "http://localhost:3000",
    productContextSecret: "fixture-key",
    requireUser: async () => ({ id: userId }),
    isTrustedOrigin: () => true,
    runner,
  });
  const chat = (message: string, productContext?: string) =>
    app.inject({
      method: "POST",
      url: "/api/agent/chat",
      payload: {
        message,
        mandateId: "nike-mandate",
        requestKey: crypto.randomUUID(),
        ...(productContext ? { productContext } : {}),
      },
    });
  return {
    app,
    runner,
    search,
    create,
    chat,
    changeOwner: () => {
      userId = "other-owner";
    },
    changeVersion: () => {
      version = 2;
    },
  };
}
describe("selection and external checkout", () => {
  it("clears a previous reference when a new search has no matches", async () => {
    const f = fixture();
    try {
      const initial = await f.chat("Show shoes");
      f.search.mockResolvedValueOnce({ products: [] });
      const empty = await f.chat("Search for other options", initial.json().productContext);
      expect(empty.statusCode).toBe(200);
      expect(empty.json().productContext).toBeNull();
      expect(empty.json().message).toContain("couldn’t find products matching");
    } finally {
      await f.app.close();
    }
  });
  it("retains the exact previous product, retailer and price without another AI or search call", async () => {
    const f = fixture();
    try {
      const search = await f.chat("tell me the shoes or sneakers from this budget");
      expect(search.statusCode).toBe(200);
      expect(search.json().message).toContain("https://ka-yo.com/product/pegasus");
      const selected = await f.chat(
        "M AIR PEGASUS 2005 — $49.00 USD at ka-yo.com (new). get me this",
        search.json().productContext,
      );
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toMatchObject({
        explanation: null,
        proposals: [],
        steps: [{ name: "check_checkout_availability", status: "completed" }],
      });
      expect(selected.json().message).toContain("$49.00 USD");
      expect(selected.json().message).toContain("https://ka-yo.com/product/pegasus");
      expect(selected.json().message).toContain("can’t buy external retailer products yet");
      expect(selected.json().message).not.toContain("$10.00");
      expect(f.runner).toHaveBeenCalledTimes(1);
      expect(f.search).toHaveBeenCalledTimes(1);
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("treats an external proposal attempt as an explained limitation rather than 503 or a false purchase claim", async () => {
    const f = fixture({ propose: true });
    try {
      const response = await f.chat(
        "Air Pegasus 2005 Mens Running Shoes — $10.00 USD at dtlr.com. i want to buy this",
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().message).toContain(
        "No order, approval request or payment has been created",
      );
      expect(response.json().message).not.toContain("I bought it");
      expect(response.json().explanation).toBeNull();
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("asks for the listing when a pronoun could refer to multiple products", async () => {
    const f = fixture();
    try {
      const search = await f.chat("Show shoes");
      const response = await f.chat("buy this", search.json().productContext);
      expect(response.statusCode).toBe(200);
      expect(response.json().message).toContain("Copy the exact product title");
      expect(f.runner).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });
  it.each(["owner", "version", "tamper"])(
    "rejects a %s mismatch without trusting client product facts",
    async (change) => {
      const f = fixture();
      try {
        const search = await f.chat("Show shoes");
        let token = search.json().productContext;
        if (change === "owner") f.changeOwner();
        if (change === "version") f.changeVersion();
        if (change === "tamper") token = `x${token}`;
        const response = await f.chat("get me this", token);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe("SHOPPING_SELECTION_EXPIRED");
        expect(f.runner).toHaveBeenCalledTimes(1);
        expect(f.create).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    },
  );
  it("preserves a real checkout conflict status for demo products instead of reporting service unavailability", async () => {
    const f = fixture({ propose: true, demo: true });
    try {
      const response = await f.chat("buy demo shoes");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "SHOPPING_OPERATION_REJECTED",
        error: "Product changed. Select a current product.",
      });
      expect(f.create).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });
  it("does not expose unsafe retailer URLs", async () => {
    const f = fixture({ unsafeUrl: true, propose: true });
    try {
      const response = await f.chat("get me this");
      expect(response.statusCode).toBe(200);
      expect(response.json().message).not.toContain("javascript:");
      expect(response.json().message).toContain("No retailer product link was supplied");
    } finally {
      await f.app.close();
    }
  });
});

function demoListing(overrides: Record<string, unknown>) {
  return {
    source: "demo",
    externalId: "demo-headphones-139",
    title: "Sony WH-1000XM5 Noise Cancelling Headphones",
    brand: "Sony",
    category: "Headphones",
    condition: "NEW",
    priceMinor: 13_900,
    currency: "USD",
    merchant: "Mandate Demo Store",
    productUrl: null,
    imageUrl: "/demo-products/over-ear-graphite.svg",
    checkoutEligible: true,
    ...overrides,
  };
}

function excludedFixture() {
  const app = Fastify();
  const listings = [
    demoListing({}),
    demoListing({
      externalId: "demo-headphones-refurbished",
      title: "Bose QuietComfort Refurbished Headphones",
      brand: "Bose",
      condition: "REFURBISHED",
      priceMinor: 12_000,
    }),
    demoListing({
      externalId: "demo-headphones-beats-149",
      title: "Beats Studio Pro Wireless Headphones",
      brand: "Beats",
      priceMinor: 14_900,
      imageUrl: "https://tracker.example/pixel.svg",
    }),
    demoListing({
      externalId: "demo-headphones-bundle-220",
      title: "Sony WH-1000XM5 + Travel Case Bundle",
      priceMinor: 22_000,
    }),
  ];
  const search = vi.fn(async () => ({ products: listings, mode: "demo", fallback: false }));
  const create = vi.fn(async (request: FastifyRequest, reply: FastifyReply) =>
    reply.status(201).send({
      proposal: {
        id: `proposal-${(request.body as { productId: string }).productId}`,
        status: "PROPOSED",
      },
    }),
  );
  const evaluate = vi.fn(async (request: FastifyRequest) => ({
    proposal: { id: (request.params as { id: string }).id, status: "BLOCKED" },
    decision: {
      decision: "BLOCK",
      reasonCodes: ["CONDITION_NOT_ALLOWED"],
      explanation: {
        decision: "BLOCK",
        headline: "Blocked by your mandate — Your mandate allows new only; this one is refurbished",
        summary: "This is a hard rule.",
        approvalCanOverride: false,
        checks: [],
      },
    },
  }));
  app.post("/api/products/search", search);
  app.post("/api/proposals", create);
  app.post("/api/proposals/:id/evaluate", evaluate);
  const audit = vi.fn(async () => ({}));
  const now = Date.now();
  const database = {
    platformSetting: { findMany: async () => [] },
    auditEvent: { create: audit },
    mandate: {
      findFirst: async () => ({
        id: "headphones-mandate",
        status: "ACTIVE",
        version: 1,
        startsAt: new Date(now - 60_000),
        expiresAt: new Date(now + 86_400_000),
        activeVersion: {
          version: 1,
          canonicalRules: {
            title: "Headphones",
            productIntent: "Noise-cancelling headphones",
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
          },
        },
      }),
    },
  } as unknown as DatabaseClient;
  const toolResults: unknown[] = [];
  const runner = vi.fn(async (_input, tools: ShoppingAgentToolHandlers) => {
    await tools.get_active_mandates!({}, toolContext);
    toolResults.push(
      await tools.search_products!(
        { query: "headphones", category: null, maximumPriceMinor: null, brands: [] },
        toolContext,
      ),
    );
    return finalResult;
  });
  registerShoppingAgentRoutes(app, {
    app,
    database,
    appUrl: "http://localhost:3000",
    productContextSecret: "fixture-key",
    requireUser: async () => ({ id: "owner" }),
    isTrustedOrigin: () => true,
    runner,
  });
  const chat = (message: string, productContext?: string) =>
    app.inject({
      method: "POST",
      url: "/api/agent/chat",
      payload: {
        message,
        mandateId: "headphones-mandate",
        requestKey: crypto.randomUUID(),
        ...(productContext ? { productContext } : {}),
      },
    });
  return { app, runner, search, create, evaluate, audit, chat, toolResults };
}

describe("mandate-excluded listings", () => {
  it("returns excluded listings with reasons and never offers them to the model", async () => {
    const f = excludedFixture();
    try {
      const response = await f.chat("Show me wireless headphones");
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.excludedProducts).toEqual([
        expect.objectContaining({
          externalId: "demo-headphones-refurbished",
          reasons: ["Your mandate allows new only; this one is refurbished."],
          imageUrl: "/demo-products/over-ear-graphite.svg",
        }),
        expect.objectContaining({
          externalId: "demo-headphones-beats-149",
          reasons: ["Beats isn’t an allowed brand; your mandate allows Sony or Bose."],
          imageUrl: null,
        }),
        expect.objectContaining({
          externalId: "demo-headphones-bundle-220",
          reasons: ["$220 is above your $180 maximum per purchase."],
        }),
      ]);
      expect(body.message).toContain("3 other results were filtered out by your mandate");
      const toolResult = f.toolResults[0] as {
        products: { externalId: string }[];
        excludedByMandateCount: number;
      };
      expect(toolResult.products.map((product) => product.externalId)).toEqual([
        "demo-headphones-139",
      ]);
      expect(toolResult.excludedByMandateCount).toBe(3);
      expect(JSON.stringify(toolResult)).not.toContain("Refurbished");
    } finally {
      await f.app.close();
    }
  });

  it("evaluates an explicitly requested excluded listing server-side as a real BLOCK", async () => {
    const f = excludedFixture();
    try {
      const search = await f.chat("Show me headphones");
      const response = await f.chat(
        "Buy the Bose QuietComfort Refurbished Headphones anyway",
        search.json().productContext,
      );
      expect(response.statusCode).toBe(200);
      expect(f.runner).toHaveBeenCalledTimes(1);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.create.mock.calls[0]?.[0].body).toMatchObject({
        source: "demo",
        productId: "demo-headphones-refurbished",
        quantity: 1,
      });
      expect(f.evaluate).toHaveBeenCalledTimes(1);
      const body = response.json();
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0].decision.decision).toBe("BLOCK");
      expect(body.message).toContain("AgentGuard blocked it");
      expect(body.message).toContain("approval can’t override it");
      expect(body.explanation).toBeNull();
      expect(f.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "PRODUCT_SELECTED",
            payload: expect.objectContaining({
              aiReason: "user_selected_mandate_excluded_product",
            }),
          }),
        }),
      );
    } finally {
      await f.app.close();
    }
  });

  it("evaluates an excluded listing named in the same message after the search", async () => {
    const f = excludedFixture();
    try {
      const response = await f.chat("Buy the Beats Studio Pro Wireless Headphones");
      expect(response.statusCode).toBe(200);
      expect(f.runner).toHaveBeenCalledTimes(1);
      expect(f.create.mock.calls[0]?.[0].body).toMatchObject({
        productId: "demo-headphones-beats-149",
      });
      expect(response.json().message).toContain("AgentGuard blocked it");
      expect(response.json().message).not.toContain("I bought it");
    } finally {
      await f.app.close();
    }
  });

  it("does not create a proposal when the user only browses", async () => {
    const f = excludedFixture();
    try {
      await f.chat("What about the Bose QuietComfort Refurbished Headphones?");
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
});
