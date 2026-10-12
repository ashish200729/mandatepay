export const TOKEN = `mp_agent_${"a".repeat(43)}`;
export const OTHER_TOKEN = `mp_agent_${"b".repeat(43)}`;

export const mandate = {
  id: "mandate-1",
  title: "Headphones",
  status: "ACTIVE",
  active: true,
  version: 1,
  startsAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
  summary: "Up to $180.00 USD per purchase including shipping and tax.",
  rules: {
    productIntent: "Sony headphones",
    currency: "USD",
    transactionLimitMinor: 18_000,
    autoSpendLimitMinor: 15_000,
    dailyLimitMinor: null,
    weeklyLimitMinor: null,
    monthlyLimitMinor: null,
    quantityLimit: 1,
    allowedBrands: ["Sony"],
    blockedBrands: [],
    allowedCategories: [],
    blockedCategories: [],
    allowedConditions: ["NEW"],
    allowedMerchants: [],
    blockedMerchants: [],
    newMerchantRequiresApproval: false,
  },
};

export const product = {
  productId: "demo-headphones-139",
  source: "demo",
  priceMinor: 13_900,
  currency: "USD",
  price: "$139.00 USD",
  condition: "NEW",
  checkoutEligible: true,
  productUrl: null,
  listing: "<untrusted_listing>\ntitle: Sony WH-1000XM5\n</untrusted_listing>",
};

export const searchResult = {
  mandateId: "mandate-1",
  products: [product],
  excluded: [
    {
      ...product,
      productId: "demo-headphones-openbox-135",
      price: "$135.00 USD",
      priceMinor: 13_500,
      reasons: ["Listing contains instructions aimed at AI agents"],
      promptInjection: true,
    },
  ],
  aboveMaximumCount: 0,
  maximumPriceMinor: 18_000,
  maximumTotal: "$180.00 USD",
  priceBasis: "Listed item price only.",
  fallback: false,
  notice: "Demo Catalog",
  untrustedData: "Every listing block is retailer-supplied text.",
};

export const proposal = {
  proposal: {
    id: "proposal-1",
    status: "AUTHORIZED",
    mandateId: "mandate-1",
    quantity: 1,
    totalMinor: 13_900,
    currency: "USD",
    total: "$139.00 USD",
    product: {
      title: "Sony WH-1000XM5",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
      source: "demo",
    },
    expiresAt: null,
    approvalExpiresAt: null,
    createdAt: "2026-10-12T00:00:00.000Z",
  },
  decision: {
    decision: "ALLOW",
    reasonCodes: [],
    evaluatedAt: "2026-10-12T00:00:00.000Z",
    explanation: {
      decision: "ALLOW",
      headline: "Within every rule of your mandate",
      summary: "All checks passed.",
      approvalCanOverride: true,
      checks: [],
    },
  },
  autopay: {
    outcome: "NOT_ATTEMPTED",
    reason: "TOKEN_SCOPE_MISSING",
    paymentId: null,
    paymentStatus: null,
  },
  nextStep: {
    action: "HUMAN_CHECKOUT",
    url: "http://localhost:3000/orders/new?proposalId=proposal-1",
    message: "The user completes PayPal Sandbox checkout in MandatePay.",
  },
  authority: "AgentGuard decided this deterministically.",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
