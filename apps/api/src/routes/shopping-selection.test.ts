import Fastify from "fastify";
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
