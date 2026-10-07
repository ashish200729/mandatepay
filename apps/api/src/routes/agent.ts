import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DatabaseError,
  MandateRepository,
  PaymentStatus,
  Prisma,
  type DatabaseClient,
} from "@mandatepay/database";
import {
  AGENT_PROPOSAL_CALLER_HEADER,
  AGENT_PROPOSAL_CALLER_VALUE,
  CanonicalMandateSchema,
  PLATFORM_CONTROL_MESSAGES,
  parseDecimalToMinorUnits,
  formatMinorUnits,
  toMinorUnits,
  type AgentToolFact,
  type CanonicalMandate,
} from "@mandatepay/shared";
import {
  agentProposalsOpen,
  assertShoppingAgentOpen,
  PlatformControlDenied,
} from "../services/platform-controls.js";
import {
  FindTransactionToolInputSchema,
  PrepareRefundRequestToolInputSchema,
  ShoppingAgentError,
  OpenAIProviderError,
  MandateParserError,
  ShoppingAgentToolSchemas,
  type ShoppingAgentResult,
  type ShoppingAgentToolHandlers,
} from "@mandatepay/agent";
import {
  paymentReceiptInclude,
  serializePayment,
  type PaymentReceipt,
} from "../services/payments.js";
import {
  agentFailureClass,
  persistAgentRun,
  proposalIdFrom,
  refundDraftIdFrom,
  traceShoppingTools,
} from "../services/agent-telemetry.js";
import {
  shoppingProductSchema,
  signShoppingProducts,
  readShoppingProducts,
  type ShoppingProduct,
} from "../services/shopping-product-context.js";

type AuthenticatedUser = { id: string };

export interface ShoppingAgentRouteContext {
  readonly app: FastifyInstance;
  readonly database: DatabaseClient;
  readonly appUrl: string;
  readonly requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  readonly isTrustedOrigin: (origin: string | undefined) => boolean;
  readonly runner: (
    input: { message: string; now: string },
    tools: ShoppingAgentToolHandlers,
  ) => Promise<ShoppingAgentResult>;
  readonly modelId?: string;
  readonly productContextSecret?: string;
}

const chatBodySchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),
    mandateId: z.string().trim().min(1).max(255).optional(),
    requestKey: z.string().trim().min(1).max(255),
    productContext: z.string().min(1).max(50_000).optional(),
  })
  .strict();

const activeStatuses: PaymentStatus[] = [PaymentStatus.COMPLETED, PaymentStatus.PARTIALLY_REFUNDED];
const rateWindowMs = 60_000;
const rateLimit = 5;

type SafeProduct = ShoppingProduct;

class ShoppingOperationError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super("Shopping operation was rejected.");
  }
}

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function cookieOf(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie;
  return Array.isArray(value) ? value[0] : value;
}

function safeError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof OpenAIProviderError) {
    if (cause.code === "UPSTREAM_TIMEOUT" || cause.code === "UPSTREAM_ABORTED") {
      return reply.status(504).send({
        code: "SHOPPING_TIMEOUT",
        error:
          "The shopping assistant took too long to respond. Retry the same request in a moment.",
      });
    }
    return reply.status(503).send({
      code: "SHOPPING_AI_UNAVAILABLE",
      error: "The shopping assistant’s AI service is unavailable. Retry the same request shortly.",
    });
  }
  if (cause instanceof MandateParserError) {
    return reply.status(502).send({
      code: "SHOPPING_AI_RESPONSE_INVALID",
      error:
        "The shopping assistant couldn’t read the AI service’s response. Retry the same request in a moment.",
    });
  }
  if (cause instanceof ShoppingAgentError) {
    if (cause.code === "TOOL_TIMEOUT") {
      return reply.status(504).send({
        code: "SHOPPING_TIMEOUT",
        error:
          "The product search or comparison took too long. Retry the same request in a moment.",
      });
    }
    if (cause.code === "TOOL_HANDLER_FAILED" || cause.code === "TOOL_UNAVAILABLE") {
      return reply.status(503).send({
        code: "SHOPPING_TOOLS_UNAVAILABLE",
        error:
          "Product search or comparison is temporarily unavailable. Retry the same request shortly.",
      });
    }
    if (cause.code === "INVALID_INPUT") {
      return reply.status(400).send({ error: "Shopping request is invalid." });
    }
    return reply.status(502).send({
      code: "SHOPPING_AI_RESPONSE_INVALID",
      error:
        "The shopping assistant couldn’t read the AI service’s response. Retry the same request in a moment.",
    });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND")
      return reply.status(404).send({ error: "Shopping record not found." });
    if (cause.code === "CONFLICT" || cause.code === "INVALID_STATE") {
      return reply.status(409).send({ error: "Shopping request is stale or unavailable." });
    }
    return reply.status(400).send({ error: "Shopping request is invalid." });
  }
  return reply.status(503).send({ error: "Shopping agent is temporarily unavailable." });
}

function jsonBody(response: { statusCode: number; body: string }): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProduct(value: unknown): SafeProduct | null {
  if (!isRecord(value)) return null;
  const source = value.source === "demo" || value.source === "channel3" ? value.source : null;
  if (
    !source ||
    typeof value.externalId !== "string" ||
    typeof value.title !== "string" ||
    (value.brand !== null && typeof value.brand !== "string") ||
    (value.category !== null && typeof value.category !== "string") ||
    typeof value.condition !== "string" ||
    typeof value.priceMinor !== "number" ||
    !Number.isSafeInteger(value.priceMinor) ||
    typeof value.currency !== "string" ||
    typeof value.merchant !== "string"
  ) {
    return null;
  }
  const parsed = shoppingProductSchema.safeParse({
    source,
    externalId: value.externalId,
    title: value.title,
    brand: value.brand,
    category: value.category,
    categoryPath:
      isRecord(value.metadata) && Array.isArray(value.metadata.categoryPath)
        ? value.metadata.categoryPath
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, 40)
        : [],
    condition: value.condition,
    priceMinor: value.priceMinor,
    currency: value.currency,
    merchant: value.merchant,
    productUrl: retailerUrl(value.productUrl),
  });
  return parsed.success ? parsed.data : null;
}

function retailerUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_000) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function safePayment(payment: PaymentReceipt) {
  const dto = serializePayment(payment);
  return {
    id: dto.id,
    proposalId: dto.proposalId,
    status: dto.status,
    amount: dto.amount,
    currency: dto.currency,
    capturedAt: dto.capturedAt,
    product: dto.product,
    mandate: dto.mandate,
  };
}

function usd(value: CanonicalMandate["transactionLimit"]) {
  return `$${formatMinorUnits(value)} USD`;
}

function matchesRestriction(
  value: string | null,
  allowed: readonly string[],
  blocked: readonly string[],
) {
  const normalized = value?.toLowerCase();
  return (
    (!allowed.length || allowed.some((entry) => entry.toLowerCase() === normalized)) &&
    !blocked.some((entry) => entry.toLowerCase() === normalized)
  );
}

function matchesCategory(product: SafeProduct, rules: CanonicalMandate) {
  const labels = [product.category, ...product.categoryPath]
    .filter((label): label is string => label !== null)
    .map((label) => label.toLowerCase());
  return (
    (!rules.allowedCategories.length ||
      rules.allowedCategories.some((category) => labels.includes(category.toLowerCase()))) &&
    !rules.blockedCategories.some((category) => labels.includes(category.toLowerCase()))
  );
}

// Product descriptions are plain data, never instructions or Markdown syntax.
function markdownFact(value: string) {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, "\\$&");
}

function retailerLink(product: SafeProduct) {
  if (!product.productUrl) return markdownFact(product.merchant);
  try {
    const url = new URL(product.productUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return markdownFact(product.merchant);
    const destination = url.href.replace(/[<>\s()\\]/gu, (char) => encodeURIComponent(char));
    return `[${markdownFact(product.merchant)}](<${destination}>)`;
  } catch {
    return markdownFact(product.merchant);
  }
}

function wantsPurchase(message: string) {
  return /\b(?:buy|purchase|order|checkout)\b|\bget\s+(?:me\s+)?(?:this|that|these|it)\b/iu.test(
    message,
  );
}

function selectedProduct(message: string, products: readonly SafeProduct[]) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const query = normalize(message);
  const candidates = products.filter((product) => query.includes(normalize(product.title)));
  const longestTitle = Math.max(0, ...candidates.map((product) => normalize(product.title).length));
  let matches = candidates.filter((product) => normalize(product.title).length === longestTitle);
  // A pasted retailer or listed price can disambiguate identical product titles.
  const retailerMatches = matches.filter((product) => query.includes(normalize(product.merchant)));
  if (retailerMatches.length) matches = retailerMatches;
  const priceMatches = matches.filter((product) =>
    message.includes(`$${formatMinorUnits(toMinorUnits(product.priceMinor))}`),
  );
  if (priceMatches.length) matches = priceMatches;
  return matches.length === 1
    ? matches[0]
    : products.length === 1 && /\b(?:this|that|it)\b/iu.test(message)
      ? products[0]
      : null;
}

function externalPurchaseReply(product: SafeProduct) {
  return `You selected **${markdownFact(product.title)}** — ${usd(toMinorUnits(product.priceMinor))} at ${retailerLink(product)}.\n\nI can help compare this retailer’s listing, but MandatePay can’t buy external retailer products yet. Checkout here currently supports Demo Catalog products only.\n\n${product.productUrl ? "Open the retailer link to check the current price, size, stock, shipping and tax before buying there." : "No retailer product link was supplied for this listing. Search for this exact product on the retailer’s website to check its current price, size and stock."}\n\nNo order, approval request or payment has been created.`;
}

function discoveryReply(
  rules: CanonicalMandate,
  products: readonly SafeProduct[],
  comparison: boolean,
) {
  const maximum = usd(rules.transactionLimit);
  const approval =
    rules.autoSpendLimit === 0
      ? "Your approval is required before every purchase."
      : `Your automatic purchase limit is ${usd(rules.autoSpendLimit)}. Every proposal still needs a policy check.`;
  if (!products.length) {
    return `Your maximum total budget is **${maximum}**. ${approval}\n\nI couldn’t find products matching this search and your mandate’s restrictions within that maximum. Try a broader product description or review the restrictions in your mandate.`;
  }
  const options = [...products].sort((a, b) => a.priceMinor - b.priceMinor);
  const lines = options
    .slice(0, 8)
    .map((product) =>
      comparison
        ? `| ${markdownFact(product.title)} | ${usd(toMinorUnits(product.priceMinor))} | ${retailerLink(product)} | ${product.condition.toLowerCase()} |`
        : `- **${markdownFact(product.title)}** — ${usd(toMinorUnits(product.priceMinor))} at ${retailerLink(product)} (${product.condition.toLowerCase()}).`,
    );
  const choices = comparison
    ? `| Product | Listed price | Retailer | Condition |\n| --- | --- | --- | --- |\n${lines.join("\n")}`
    : lines.join("\n");
  const source = options.every((product) => product.source === "demo")
    ? "Demo Catalog — illustrative products from the sandbox merchant."
    : "Live retailer listings are available for comparison. MandatePay checkout currently supports Demo Catalog products.";
  return `These options fit your **${maximum} maximum** at their listed product prices. ${approval}\n\n${choices}${options.length > 8 ? `\n\n${options.length - 8} more matching options were found.` : ""}\n\nShipping and tax still need to fit within your maximum before a purchase can proceed.\n\n${source}`;
}

async function internalJSON(
  context: ShoppingAgentRouteContext,
  request: FastifyRequest,
  method: "POST" | "GET",
  url: string,
  payload?: unknown,
) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      origin: context.appUrl,
      ...(cookieOf(request) ? { cookie: cookieOf(request) } : {}),
      ...(url === "/api/proposals" && method === "POST"
        ? { [AGENT_PROPOSAL_CALLER_HEADER]: AGENT_PROPOSAL_CALLER_VALUE }
        : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  if (payload !== undefined) options.payload = payload;
  const response = (await context.app.inject(options as never)) as unknown as {
    statusCode: number;
    body: string;
  };
  const body = jsonBody(response);
  if (response.statusCode >= 400 && response.statusCode < 500)
    throw new ShoppingOperationError(
      response.statusCode,
      isRecord(body) && typeof body.error === "string"
        ? body.error.slice(0, 240)
        : "This shopping request cannot proceed. Check the product and mandate, then try again.",
    );
  if (response.statusCode >= 400)
    throw new DatabaseError("INVALID_STATE", "Internal shopping operation failed.");
  return body;
}

async function activeMandate(
  database: DatabaseClient,
  userId: string,
  mandateId: string | undefined,
) {
  const now = new Date();
  if (mandateId) {
    const mandate = await new MandateRepository(database).getByIdForUser(mandateId, userId);
    if (
      mandate.status !== "ACTIVE" ||
      !mandate.activeVersion ||
      now < mandate.startsAt ||
      now >= mandate.expiresAt
    ) {
      throw new DatabaseError("INVALID_STATE", "Mandate is not currently active.");
    }
    return mandate;
  }
  const mandates = await database.mandate.findMany({
    where: { userId, status: "ACTIVE", startsAt: { lte: now }, expiresAt: { gt: now } },
    include: { activeVersion: true },
    take: 2,
  });
  if (mandates.length !== 1 || !mandates[0]?.activeVersion) return null;
  return mandates[0];
}

export function registerShoppingAgentRoutes(
  app: FastifyInstance,
  context: ShoppingAgentRouteContext,
) {
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  const productContextSecret = context.productContextSecret ?? randomBytes(32).toString("hex");

  app.post("/api/agent/chat", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return reply.status(403).send({ error: "Request origin is not trusted." });
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    try {
      await assertShoppingAgentOpen(context.database);
    } catch (cause) {
      if (cause instanceof PlatformControlDenied)
        return reply.status(cause.httpStatus).send({ error: cause.message, code: cause.code });
      throw cause;
    }
    const nowMs = Date.now();
    for (const [key, value] of rateLimits) if (value.resetAt <= nowMs) rateLimits.delete(key);
    const currentRate = rateLimits.get(user.id);
    if (!currentRate && rateLimits.size >= 2_048) {
      return reply.status(429).send({ error: "Shopping agent is busy." });
    }
    if (!currentRate || currentRate.resetAt <= nowMs) {
      rateLimits.set(user.id, { count: 1, resetAt: nowMs + rateWindowMs });
    } else if (currentRate.count >= rateLimit) {
      reply.header("retry-after", Math.ceil((currentRate.resetAt - nowMs) / 1000));
      return reply.status(429).send({ error: "Too many shopping requests. Try again shortly." });
    } else {
      currentRate.count += 1;
    }

    const body = chatBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Shopping request is invalid." });
    try {
      const mandate = await activeMandate(context.database, user.id, body.data.mandateId);
      const rules = mandate
        ? CanonicalMandateSchema.parse(mandate.activeVersion?.canonicalRules)
        : null;
      // Refund discovery remains available after a purchase mandate expires or is revoked.
      // Purchase tools still require exactly one currently active, owned mandate.
      const mandateId = mandate?.id;
      const knownProducts = new Map<string, SafeProduct>();
      const owner = mandate
        ? {
            userId: user.id,
            mandateId: mandate.id,
            mandateVersion: mandate.activeVersion?.version ?? mandate.version,
          }
        : null;
      const previousProducts =
        body.data.productContext && owner
          ? readShoppingProducts(body.data.productContext, owner, productContextSecret)
          : [];
      if (body.data.productContext && (!owner || !previousProducts))
        return reply.status(409).send({
          code: "SHOPPING_SELECTION_EXPIRED",
          error:
            "Your previous product list expired or belongs to another mandate. Search again to choose a current product.",
        });
      for (const product of previousProducts ?? []) knownProducts.set(product.externalId, product);
      let discoveredProducts: SafeProduct[] = [];
      let comparedProducts: SafeProduct[] | null = null;
      const proposals: unknown[] = [];
      let refundDraft: unknown = null;
      const steps: Array<{ name: string; status: "completed" }> = [];
      const operationFailures: ShoppingOperationError[] = [];
      const operation = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        if (operationFailures.length) return null;
        try {
          return await internalJSON(context, request, method, url, payload);
        } catch (cause) {
          if (!(cause instanceof ShoppingOperationError)) throw cause;
          operationFailures.push(cause);
          return null;
        }
      };
      let externalSelection: SafeProduct | null = null;
      const selection = wantsPurchase(body.data.message)
        ? selectedProduct(body.data.message, previousProducts ?? [])
        : null;
      if (selection?.source === "channel3")
        return reply.send({
          message: externalPurchaseReply(selection),
          explanation: null,
          proposals: [],
          refundDraft: null,
          steps: [{ name: "check_checkout_availability", status: "completed" }],
          productContext: body.data.productContext,
        });
      if (
        wantsPurchase(body.data.message) &&
        previousProducts?.length &&
        previousProducts.every((product) => product.source === "channel3")
      )
        return reply.send({
          message:
            "These are external retailer listings, so MandatePay can’t buy them directly. Copy the exact product title, listed price and retailer from the previous results so I can identify the listing. You can also open its retailer link to check size, stock and the final total. No order or payment has been created.",
          explanation: null,
          proposals: [],
          refundDraft: null,
          steps: [{ name: "check_checkout_availability", status: "completed" }],
          productContext: body.data.productContext,
        });

      const tools: ShoppingAgentToolHandlers = {
        get_active_mandates: async () => {
          steps.push({ name: "get_active_mandates", status: "completed" });
          return {
            mandates:
              mandate && rules
                ? [
                    {
                      id: mandate.id,
                      title: mandate.activeVersion?.title ?? mandate.title,
                      version: mandate.activeVersion?.version ?? mandate.version,
                      expiresAt: mandate.expiresAt.toISOString(),
                      rules,
                      budget: {
                        currency: rules.currency,
                        moneyUnit: "USD cents; 100 cents = 1 USD",
                        maximumTotalMinor: rules.transactionLimit,
                        maximumTotal: usd(rules.transactionLimit),
                        automaticLimitMinor: rules.autoSpendLimit,
                        automaticLimit: usd(rules.autoSpendLimit),
                        approval:
                          rules.autoSpendLimit === 0
                            ? "Ask before every purchase; zero automatic spending is not a missing budget."
                            : "Policy checks and any required approval still apply.",
                        includes: "The maximum total includes product price, shipping and tax.",
                      },
                      recentProducts: (previousProducts ?? []).map((product) => ({
                        ...product,
                        checkoutEligible: product.source === "demo",
                      })),
                    },
                  ]
                : [],
            ...(!mandate
              ? {
                  clarification:
                    "Select exactly one active purchase mandate before searching or proposing a purchase. Refund lookup is still available.",
                }
              : {}),
          };
        },
        search_products: async (input) => {
          if (!mandateId || !rules)
            return { error: "Select exactly one active purchase mandate first." };
          const parsed = ShoppingAgentToolSchemas.search_products.parse(input);
          const maximumPriceMinor = Math.min(
            rules.transactionLimit,
            parsed.maximumPriceMinor ?? rules.transactionLimit,
          );
          // A model's category label is a query hint, not an exact taxonomy match.
          const categoryQuery =
            parsed.category && !parsed.query.toLowerCase().includes(parsed.category.toLowerCase())
              ? `${parsed.query} ${parsed.category}`
              : parsed.query;
          // Include required brands in retrieval, before the provider's result limit.
          const brandHints = rules.allowedBrands.length ? rules.allowedBrands : parsed.brands;
          const query =
            brandHints.length &&
            !brandHints.some((brand) => categoryQuery.toLowerCase().includes(brand.toLowerCase()))
              ? `${brandHints.join(" or ")} ${categoryQuery}`
              : categoryQuery;
          const response = await operation("POST", "/api/products/search", {
            mandateId,
            query: query.slice(0, 500),
          });
          const products =
            isRecord(response) && Array.isArray(response.products) ? response.products : [];
          const safe = products
            .map(safeProduct)
            .filter((product): product is SafeProduct => product !== null)
            .filter((product) => {
              if (product.priceMinor > maximumPriceMinor || product.currency !== rules.currency)
                return false;
              if (
                parsed.brands.length &&
                (!product.brand ||
                  !parsed.brands.some(
                    (brand) => brand.toLowerCase() === product.brand?.toLowerCase(),
                  ))
              )
                return false;
              if (
                !matchesRestriction(product.brand, rules.allowedBrands, rules.blockedBrands) ||
                !matchesCategory(product, rules) ||
                !matchesRestriction(
                  product.merchant,
                  rules.allowedMerchants,
                  rules.blockedMerchants,
                ) ||
                !rules.allowedConditions.includes(
                  product.condition as CanonicalMandate["allowedConditions"][number],
                )
              )
                return false;
              return true;
            });
          request.log.info(
            {
              event: "shopping_search_filtered",
              retrievedCount: products.length,
              matchedCount: safe.length,
            },
            "Shopping search restrictions applied",
          );
          for (const product of safe) knownProducts.set(product.externalId, product);
          discoveredProducts = safe;
          comparedProducts = null;
          steps.push({ name: "search_products", status: "completed" });
          return {
            products: safe,
            maximumTotal: usd(rules.transactionLimit),
            maximumPriceMinor,
            priceBasis: "Listed item price only; shipping and tax must also fit the maximum total.",
            ...(isRecord(response) && typeof response.notice === "string"
              ? { notice: response.notice }
              : {}),
          };
        },
        get_product_details: async (input) => {
          const parsed = ShoppingAgentToolSchemas.get_product_details.parse(input);
          const product = knownProducts.get(parsed.productId);
          if (!product) return { error: "Product must come from a trusted search result." };
          steps.push({ name: "get_product_details", status: "completed" });
          return { product };
        },
        compare_products: async (input) => {
          const parsed = ShoppingAgentToolSchemas.compare_products.parse(input);
          const products = parsed.productIds.map((id) => knownProducts.get(id));
          if (products.some((product) => !product))
            return { error: "Products must come from trusted search results." };
          comparedProducts = products.filter(
            (product): product is SafeProduct => product !== undefined,
          );
          steps.push({ name: "compare_products", status: "completed" });
          return {
            products: products.filter((product): product is SafeProduct => product !== undefined),
          };
        },
        create_purchase_proposal: async (input) => {
          if (!(await agentProposalsOpen(context.database))) {
            return {
              error: PLATFORM_CONTROL_MESSAGES.AGENT_PROPOSALS_DISABLED,
              code: "AGENT_PROPOSALS_DISABLED",
            };
          }
          if (!mandateId) return { error: "Select exactly one active purchase mandate first." };
          const parsed = ShoppingAgentToolSchemas.create_purchase_proposal.parse(input);
          const product = knownProducts.get(parsed.productId);
          if (!product || product.source !== parsed.source)
            return { error: "Product must come from a trusted search result." };
          if (product.source === "channel3") {
            externalSelection = product;
            steps.push({ name: "check_checkout_availability", status: "completed" });
            return {
              error: "EXTERNAL_CHECKOUT_UNSUPPORTED",
              product,
              checkoutEligible: false,
              message:
                "MandatePay cannot purchase external retailer listings. Explain this limitation and offer the verified retailer link. No proposal or payment was created.",
            };
          }
          const response = await operation("POST", "/api/proposals", {
            mandateId,
            source: parsed.source,
            productId: parsed.productId,
            quantity: parsed.quantity,
            requestKey: body.data.requestKey,
          });
          if (!isRecord(response) || !isRecord(response.proposal))
            return { error: "Proposal could not be prepared." };
          let actual = response;
          const proposalId = typeof response.proposal.id === "string" ? response.proposal.id : null;
          if (!proposalId) return { error: "Proposal could not be prepared." };
          const evaluated =
            response.proposal.status === "PROPOSED"
              ? await operation(
                  "POST",
                  `/api/proposals/${encodeURIComponent(proposalId)}/evaluate`,
                  {},
                )
              : await operation("GET", `/api/proposals/${encodeURIComponent(proposalId)}`);
          if (isRecord(evaluated) && isRecord(evaluated.proposal)) actual = evaluated;
          else
            actual = (await operation(
              "GET",
              `/api/proposals/${encodeURIComponent(proposalId)}`,
            )) as Record<string, unknown>;
          if (operationFailures.length)
            return { error: "The purchase proposal operation was rejected." };
          proposals.push(actual);
          await context.database.auditEvent.create({
            data: {
              userId: user.id,
              eventType: "PRODUCT_SELECTED",
              entityType: "PURCHASE_PROPOSAL",
              entityId: proposalId,
              payload: {
                proposalId,
                mandateId,
                source: parsed.source,
                quantity: parsed.quantity,
                aiReason: "model_selected_server_validated_product",
                queryHash: createHash("sha256").update(body.data.message).digest("hex"),
                ...(context.modelId ? { modelId: context.modelId } : {}),
              },
            },
          });
          steps.push({ name: "create_purchase_proposal", status: "completed" });
          return actual;
        },
        find_transaction: async (input) => {
          const parsed = FindTransactionToolInputSchema.parse(input);
          const where: Prisma.PaymentWhereInput = {
            userId: user.id,
            isSample: false,
            status: { in: activeStatuses },
            proposal: { isSample: false },
            ...(parsed.transactionId ? { id: parsed.transactionId } : {}),
          };
          if (parsed.query) {
            const contains = { contains: parsed.query, mode: "insensitive" as const };
            where.proposal = {
              isSample: false,
              productSnapshot: {
                OR: [{ title: contains }, { merchant: contains }, { category: contains }],
              },
            };
          }
          const payments = await context.database.payment.findMany({
            where,
            include: paymentReceiptInclude,
            orderBy: { createdAt: "desc" },
            take: 25,
          });
          steps.push({ name: "find_transaction", status: "completed" });
          return { transactions: payments.map(safePayment) };
        },
        prepare_refund_request: async (input) => {
          const parsed = PrepareRefundRequestToolInputSchema.parse(input);
          const payment = await context.database.payment.findFirst({
            where: {
              id: parsed.paymentID,
              userId: user.id,
              isSample: false,
              status: { in: activeStatuses },
              proposal: { isSample: false },
            },
            include: { refunds: true },
          });
          if (!payment || !payment.paypalCaptureId)
            return { error: "Only an owned captured payment can be refunded." };
          const alreadyRefunded = payment.refunds
            .filter((refund) =>
              ["REQUESTED", "APPROVED", "SUBMITTED", "COMPLETED"].includes(refund.status),
            )
            .reduce((sum, refund) => sum + refund.amount, 0n);
          const remaining = payment.amount - alreadyRefunded;
          const amountMinor =
            parsed.amountDecimal === null ? null : parseDecimalToMinorUnits(parsed.amountDecimal);
          if (
            remaining <= 0n ||
            (amountMinor !== null && (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > remaining))
          ) {
            return { error: "Refund amount exceeds the remaining refundable amount." };
          }
          refundDraft = {
            paymentId: payment.id,
            amountMinor,
            reason: parsed.reason,
            reviewUrl: `/orders/${payment.id}`,
          };
          steps.push({ name: "prepare_refund_request", status: "completed" });
          return refundDraft;
        },
      };
      const agentStarted = new Date();
      const toolFacts: AgentToolFact[] = [];
      let result: Awaited<ReturnType<typeof context.runner>>;
      try {
        result = await context.runner(
          { message: body.data.message, now: agentStarted.toISOString() },
          traceShoppingTools(tools, toolFacts),
        );
      } catch (cause) {
        await persistAgentRun(context.database, {
          requestId: body.data.requestKey,
          userId: user.id,
          modelId: context.modelId,
          startedAt: agentStarted,
          completedAt: new Date(),
          outcome: "FAILED",
          errorClass: agentFailureClass(cause),
          proposalId: proposalIdFrom(proposals),
          refundDraftId: refundDraftIdFrom(refundDraft),
          tools: toolFacts,
        });
        throw cause;
      }
      const failedOperation = operationFailures[0];
      await persistAgentRun(context.database, {
        requestId: body.data.requestKey,
        userId: user.id,
        modelId: context.modelId,
        startedAt: agentStarted,
        completedAt: new Date(),
        outcome: failedOperation ? "FAILED" : "SUCCEEDED",
        errorClass: failedOperation ? "TOOL_FAILURE" : "NONE",
        proposalId: proposalIdFrom(proposals),
        refundDraftId: refundDraftIdFrom(refundDraft),
        tools: toolFacts,
      });
      if (failedOperation)
        return reply
          .status(failedOperation.status)
          .send({ code: "SHOPPING_OPERATION_REJECTED", error: failedOperation.publicMessage });
      const discoveryOnly =
        rules &&
        steps.some((step) => step.name === "search_products") &&
        proposals.length === 0 &&
        !refundDraft &&
        !steps.some(
          (step) => step.name === "find_transaction" || step.name === "prepare_refund_request",
        );
      const selectedExternal =
        externalSelection ??
        (wantsPurchase(body.data.message)
          ? selectedProduct(body.data.message, discoveredProducts)
          : null);
      const productContext =
        owner && steps.some((step) => step.name === "search_products")
          ? (comparedProducts ?? discoveredProducts).length
            ? signShoppingProducts(
                comparedProducts ?? discoveredProducts,
                owner,
                productContextSecret,
              )
            : null
          : (body.data.productContext ?? null);
      return reply.send({
        message:
          selectedExternal?.source === "channel3" && proposals.length === 0 && !refundDraft
            ? externalPurchaseReply(selectedExternal)
            : discoveryOnly
              ? discoveryReply(
                  rules,
                  comparedProducts ?? discoveredProducts,
                  comparedProducts !== null,
                )
              : result.finalAIExplanation.text,
        explanation: discoveryOnly || externalSelection ? null : result.finalAIExplanation,
        proposals,
        refundDraft,
        steps,
        productContext,
      });
    } catch (cause) {
      request.log.warn(
        {
          code:
            cause instanceof MandateParserError ||
            cause instanceof ShoppingAgentError ||
            cause instanceof DatabaseError
              ? cause.code
              : "SHOPPING_INTERNAL_ERROR",
          ...(cause instanceof OpenAIProviderError ? { providerStatus: cause.status } : {}),
          ...(cause instanceof ShoppingAgentError ? { tool: cause.toolName } : {}),
        },
        "Shopping request failed",
      );
      return safeError(reply, cause);
    }
  });
}
