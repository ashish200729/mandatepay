import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
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
  OpenAIConfigurationError,
  OpenAIProviderError,
  MandateParserError,
  ShoppingAgentToolSchemas,
  spotlightListing,
  type ShoppingAgentResult,
  type ShoppingAgentStepEvent,
  type ShoppingAgentToolHandlerContext,
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
  readShoppingContext,
  type ExcludedShoppingProduct,
  type ShoppingProduct,
} from "../services/shopping-product-context.js";
import {
  contentRiskMessage,
  screenProductAgainstMandate,
  stripInvisibleCharacters,
} from "@mandatepay/agentguard";
import { listingScreen } from "../services/listing-screen.js";
import { perMinuteLimit } from "./catalog.js";

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
    options?: {
      /** Aborted when a streaming client disconnects. */
      readonly signal?: AbortSignal;
      readonly onStep?: (event: ShoppingAgentStepEvent) => void;
    },
  ) => Promise<ShoppingAgentResult>;
  readonly modelId?: string;
  readonly productContextSecret?: string;
  /** Per-user chat requests per minute; defaults to AGENT_CHAT_RATE_LIMIT_PER_MINUTE or 12. */
  readonly chatRateLimitPerMinute?: number;
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
const defaultChatRateLimit = 12;

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

/** The safe status and copy for a failed chat run; provider details never leave the server. */
function safeErrorOutcome(cause: unknown): ChatOutcome {
  const fail = (status: number, body: Record<string, unknown>): ChatOutcome => ({ status, body });
  if (cause instanceof OpenAIConfigurationError) {
    return fail(503, {
      code: "SHOPPING_AI_NOT_CONFIGURED",
      error:
        "The AI service is not configured, so the shopping assistant can’t reply. An administrator needs to add the AI provider settings. You can still browse the Demo Catalog in Discover.",
    });
  }
  if (cause instanceof OpenAIProviderError) {
    if (cause.code === "UPSTREAM_TIMEOUT" || cause.code === "UPSTREAM_ABORTED") {
      return fail(504, {
        code: "SHOPPING_TIMEOUT",
        error:
          "The shopping assistant took too long to respond. Retry the same request in a moment.",
      });
    }
    return fail(503, {
      code: "SHOPPING_AI_UNAVAILABLE",
      error: "The shopping assistant’s AI service is unavailable. Retry the same request shortly.",
    });
  }
  if (cause instanceof MandateParserError) {
    return fail(502, {
      code: "SHOPPING_AI_RESPONSE_INVALID",
      error:
        "The shopping assistant couldn’t read the AI service’s response. Retry the same request in a moment.",
    });
  }
  if (cause instanceof ShoppingAgentError) {
    if (cause.code === "TOOL_TIMEOUT") {
      return fail(504, {
        code: "SHOPPING_TIMEOUT",
        error:
          "The product search or comparison took too long. Retry the same request in a moment.",
      });
    }
    if (cause.code === "TOOL_HANDLER_FAILED" || cause.code === "TOOL_UNAVAILABLE") {
      return fail(503, {
        code: "SHOPPING_TOOLS_UNAVAILABLE",
        error:
          "Product search or comparison is temporarily unavailable. Retry the same request shortly.",
      });
    }
    if (cause.code === "INVALID_INPUT") {
      return fail(400, { error: "Shopping request is invalid." });
    }
    return fail(502, {
      code: "SHOPPING_AI_RESPONSE_INVALID",
      error:
        "The shopping assistant couldn’t read the AI service’s response. Retry the same request in a moment.",
    });
  }
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") return fail(404, { error: "Shopping record not found." });
    if (cause.code === "CONFLICT" || cause.code === "INVALID_STATE") {
      return fail(409, { error: "Shopping request is stale or unavailable." });
    }
    return fail(400, { error: "Shopping request is invalid." });
  }
  return fail(503, { error: "Shopping agent is temporarily unavailable." });
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

const INJECTION_EXCLUSION_REASON =
  contentRiskMessage("malicious") ?? "Listing contains instructions aimed at AI agents";

function listingDescription(value: Record<string, unknown>): string | null {
  return isRecord(value.metadata) && typeof value.metadata.description === "string"
    ? value.metadata.description
    : null;
}

/** Deterministic prompt-injection screening of a provider listing's raw text. */

/** Retailer text for display and matching: invisible and control characters removed. */
function displayText(value: string): string {
  return stripInvisibleCharacters(value);
}

/**
 * The model's view of a product: server facts at the top level and every
 * retailer-supplied string inside one delimited, untrusted data block.
 */
function modelProduct(product: SafeProduct) {
  return {
    externalId: product.externalId,
    source: product.source,
    condition: product.condition,
    priceMinor: product.priceMinor,
    currency: product.currency,
    productUrl: product.productUrl,
    checkoutEligible: product.source === "demo",
    listing: spotlightListing({
      title: product.title,
      brand: product.brand,
      category: product.category,
      merchant: product.merchant,
      description: product.description ?? null,
    }),
  };
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
  const description = listingDescription(value);
  const cleanDescription = description ? displayText(description).slice(0, 1_000) : "";
  const parsed = shoppingProductSchema.safeParse({
    source,
    externalId: value.externalId,
    title: displayText(value.title),
    brand: value.brand === null ? null : displayText(value.brand),
    category: value.category === null ? null : displayText(value.category),
    categoryPath:
      isRecord(value.metadata) && Array.isArray(value.metadata.categoryPath)
        ? value.metadata.categoryPath
            .filter((entry): entry is string => typeof entry === "string")
            .map(displayText)
            .filter(Boolean)
            .slice(0, 40)
        : [],
    condition: value.condition,
    priceMinor: value.priceMinor,
    currency: value.currency,
    merchant: displayText(value.merchant),
    productUrl: retailerUrl(value.productUrl),
    imageUrl: demoImage(value.imageUrl),
    description: cleanDescription || null,
  });
  return parsed.success ? parsed.data : null;
}

function demoImage(value: unknown): string | null {
  return typeof value === "string" && /^\/demo-products\/[a-z0-9-]{1,80}\.svg$/u.test(value)
    ? value
    : null;
}

/** Mandate screening for display only; any proposal is still evaluated by AgentGuard. */
function mandateExclusions(product: SafeProduct, rules: CanonicalMandate): string[] {
  return screenProductAgainstMandate(rules, {
    brand: product.brand,
    categories: [product.category, ...product.categoryPath].filter(
      (label): label is string => label !== null,
    ),
    condition: product.condition,
    merchant: product.merchant,
    priceMinor: product.priceMinor,
    currency: product.currency,
  }).map((reason) => reason.message);
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
  context: { excludedCount: number; injectionCount?: number; fallback: boolean } = {
    excludedCount: 0,
    fallback: false,
  },
) {
  const injections = context.injectionCount ?? 0;
  const injected = injections
    ? `\n\n**${injections} listing${injections === 1 ? "" : "s"} tried to instruct AI shopping agents**, so ${injections === 1 ? "it was" : "they were"} set aside and can’t be bought. Product text is treated as data, never as instructions.`
    : "";
  const filtered = context.excludedCount
    ? `\n\n${context.excludedCount} other result${context.excludedCount === 1 ? " was" : "s were"} filtered out by your mandate. They’re listed below with the rule each one breaks, and can’t be bought automatically.`
    : "";
  const fallback = context.fallback
    ? "\n\nLive Channel3 discovery is unavailable right now, so these are Demo Catalog fallback results."
    : "";
  const maximum = usd(rules.transactionLimit);
  const approval =
    rules.autoSpendLimit === 0
      ? "Your approval is required before every purchase."
      : `Your automatic purchase limit is ${usd(rules.autoSpendLimit)}. Every proposal still needs a policy check.`;
  if (!products.length) {
    return `Your maximum total budget is **${maximum}**. ${approval}\n\nI couldn’t find products matching this search and your mandate’s restrictions within that maximum. Try a broader product description or review the restrictions in your mandate.${filtered}${injected}${fallback}`;
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
  return `These options fit your **${maximum} maximum** at their listed product prices. ${approval}\n\n${choices}${options.length > 8 ? `\n\n${options.length - 8} more matching options were found.` : ""}\n\nShipping and tax still need to fit within your maximum before a purchase can proceed.\n\n${source}${filtered}${injected}${fallback}`;
}

/** Server-templated reply for a proposal the user explicitly requested outside the mandate. */
function excludedProposalReply(product: SafeProduct, evaluated: unknown) {
  const decision = isRecord(evaluated) && isRecord(evaluated.decision) ? evaluated.decision : null;
  const verdict = typeof decision?.decision === "string" ? decision.decision : null;
  const headline =
    decision && isRecord(decision.explanation) && typeof decision.explanation.headline === "string"
      ? decision.explanation.headline
      : null;
  const intro = `You asked for **${markdownFact(product.title)}** — ${usd(toMinorUnits(product.priceMinor))} at ${markdownFact(product.merchant)}. I prepared that exact proposal and AgentGuard checked it against your mandate.`;
  const codes = Array.isArray(decision?.reasonCodes) ? decision.reasonCodes : [];
  if (verdict === "BLOCK" && codes.includes("PRODUCT_CONTENT_MALICIOUS")) {
    return `${intro}\n\n**Prompt-injection attempt blocked.** The seller’s listing text tries to instruct AI shopping agents, so AgentGuard blocked it as a hard rule. MandatePay treats product text as data, never as instructions.\n\nApproval can’t override this, and your mandate and PayPal were never touched.`;
  }
  if (verdict === "BLOCK") {
    return `${intro}\n\n**AgentGuard blocked it.** ${headline ? `${markdownFact(headline)}.` : ""}\n\nThis is a hard rule, so approval can’t override it and nothing can be paid. Change your mandate if you want to allow purchases like this.`;
  }
  return `${intro}\n\n${headline ? `${markdownFact(headline)}.` : "See the recorded policy decision below."}\n\nUse the proposal card below for the next step.`;
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

export type ChatStepStatus = "running" | "completed" | "blocked" | "failed";

/** One live progress step. Labels are server-templated; no model or product text. */
export interface ChatStepEvent {
  readonly id: string;
  readonly label: string;
  readonly status: ChatStepStatus;
}

interface ChatProgress {
  /** Aborted when a streaming client disconnects; no new tool starts after that. */
  readonly signal: AbortSignal;
  readonly step: (event: ChatStepEvent) => void;
}

/** The exact status and JSON body the chat endpoint returns. */
export interface ChatOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const TOOL_STEPS: Readonly<Record<string, { readonly id: string; readonly label: string }>> = {
  get_active_mandates: { id: "mandate", label: "Reading your mandate" },
  search_products: { id: "catalog", label: "Searching the catalog" },
  get_product_details: { id: "compare", label: "Comparing products" },
  compare_products: { id: "compare", label: "Comparing products" },
  create_purchase_proposal: { id: "agentguard", label: "AgentGuard evaluating" },
  find_transaction: { id: "transactions", label: "Finding your purchase" },
  prepare_refund_request: { id: "refund", label: "Preparing a refund request" },
  check_checkout_availability: { id: "checkout", label: "Checking checkout eligibility" },
};

class ChatClientGoneError extends Error {
  constructor() {
    super("The chat client disconnected.");
  }
}

/** Reports each tool as it starts and finishes. Nothing new starts after a disconnect. */
function withProgress(
  tools: ShoppingAgentToolHandlers,
  progress: ChatProgress,
): ShoppingAgentToolHandlers {
  const wrapped: Record<string, unknown> = {};
  for (const [name, handler] of Object.entries(tools)) {
    if (typeof handler !== "function") continue;
    const step = TOOL_STEPS[name];
    wrapped[name] = async (input: unknown, toolContext: ShoppingAgentToolHandlerContext) => {
      if (progress.signal.aborted) throw new ChatClientGoneError();
      if (step) progress.step({ ...step, status: "running" });
      try {
        const result = await (handler as (value: unknown, ctx: unknown) => unknown)(
          input,
          toolContext,
        );
        if (step) progress.step({ ...step, status: "completed" });
        return result;
      } catch (cause) {
        if (step) progress.step({ ...step, status: "failed" });
        throw cause;
      }
    };
  }
  return wrapped as ShoppingAgentToolHandlers;
}

/** The closing step, derived only from the recorded server outcome. */
export function chatOutcomeStep(outcome: ChatOutcome): ChatStepEvent {
  if (outcome.status >= 400) return { id: "outcome", label: "Request stopped", status: "failed" };
  const proposals = Array.isArray(outcome.body.proposals) ? outcome.body.proposals : [];
  const decisions = proposals.map((proposal) =>
    isRecord(proposal) && isRecord(proposal.decision) ? proposal.decision : null,
  );
  const codes = decisions.flatMap((decision) =>
    Array.isArray(decision?.reasonCodes) ? decision.reasonCodes : [],
  );
  if (codes.includes("PRODUCT_CONTENT_MALICIOUS"))
    return { id: "outcome", label: "Prompt-injection attempt blocked", status: "blocked" };
  if (decisions.some((decision) => decision?.decision === "BLOCK"))
    return { id: "outcome", label: "Blocked by AgentGuard", status: "blocked" };
  if (decisions.some((decision) => decision?.decision === "REQUIRE_APPROVAL"))
    return { id: "outcome", label: "Proposal ready — needs your approval", status: "completed" };
  if (proposals.length) return { id: "outcome", label: "Proposal ready", status: "completed" };
  if (outcome.body.refundDraft)
    return { id: "outcome", label: "Refund request ready", status: "completed" };
  return { id: "outcome", label: "Answer ready", status: "completed" };
}

/** One Server-Sent Events frame. JSON never contains a raw line break. */
export function encodeChatEvent(event: "step" | "result" | "error", data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ignoreProgress: ChatProgress = { signal: new AbortController().signal, step: () => {} };

export function registerShoppingAgentRoutes(
  app: FastifyInstance,
  context: ShoppingAgentRouteContext,
) {
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  const productContextSecret = context.productContextSecret ?? randomBytes(32).toString("hex");
  const rateLimit =
    context.chatRateLimitPerMinute ??
    perMinuteLimit(process.env.AGENT_CHAT_RATE_LIMIT_PER_MINUTE, defaultChatRateLimit);

  /** Origin, session, platform control, rate limit and body checks shared by both routes. */
  async function admitChat(request: FastifyRequest, reply: FastifyReply) {
    if (!context.isTrustedOrigin(originOf(request))) {
      await reply.status(403).send({ error: "Request origin is not trusted." });
      return null;
    }
    const user = await context.requireUser(request, reply);
    if (!user) return null;
    try {
      await assertShoppingAgentOpen(context.database);
    } catch (cause) {
      if (cause instanceof PlatformControlDenied) {
        await reply.status(cause.httpStatus).send({ error: cause.message, code: cause.code });
        return null;
      }
      throw cause;
    }
    const nowMs = Date.now();
    for (const [key, value] of rateLimits) if (value.resetAt <= nowMs) rateLimits.delete(key);
    const currentRate = rateLimits.get(user.id);
    if (!currentRate && rateLimits.size >= 2_048) {
      await reply.status(429).send({ error: "Shopping agent is busy." });
      return null;
    }
    if (!currentRate || currentRate.resetAt <= nowMs) {
      rateLimits.set(user.id, { count: 1, resetAt: nowMs + rateWindowMs });
    } else if (currentRate.count >= rateLimit) {
      reply.header("retry-after", Math.ceil((currentRate.resetAt - nowMs) / 1000));
      await reply.status(429).send({ error: "Too many shopping requests. Try again shortly." });
      return null;
    } else {
      currentRate.count += 1;
    }

    const body = chatBodySchema.safeParse(request.body);
    if (!body.success) {
      await reply.status(400).send({ error: "Shopping request is invalid." });
      return null;
    }
    return { user, body: body.data };
  }

  async function runChat(
    request: FastifyRequest,
    user: AuthenticatedUser,
    chat: z.output<typeof chatBodySchema>,
    progress: ChatProgress,
  ): Promise<ChatOutcome> {
    const ok = (body: Record<string, unknown>): ChatOutcome => ({ status: 200, body });
    try {
      const mandate = await activeMandate(context.database, user.id, chat.mandateId);
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
      const previousContext =
        chat.productContext && owner
          ? readShoppingContext(chat.productContext, owner, productContextSecret)
          : { products: [], excluded: [] };
      const previousProducts = previousContext?.products ?? null;
      const previousExcluded: ExcludedShoppingProduct[] = previousContext?.excluded ?? [];
      if (chat.productContext && (!owner || !previousProducts))
        return {
          status: 409,
          body: {
            code: "SHOPPING_SELECTION_EXPIRED",
            error:
              "Your previous product list expired or belongs to another mandate. Search again to choose a current product.",
          },
        };
      for (const product of previousProducts ?? []) knownProducts.set(product.externalId, product);
      let discoveredProducts: SafeProduct[] = [];
      let excludedProducts: ExcludedShoppingProduct[] = [];
      let discoveryFallback = false;
      let comparedProducts: SafeProduct[] | null = null;
      const proposals: unknown[] = [];
      let refundDraft: unknown = null;
      const steps: Array<{ name: string; status: "completed" }> = [];
      const operationFailures: ShoppingOperationError[] = [];
      const rejected = (failed: ShoppingOperationError): ChatOutcome => ({
        status: failed.status,
        body: { code: "SHOPPING_OPERATION_REJECTED", error: failed.publicMessage },
      });
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
      // An explicit request for a listing the mandate excluded is evaluated by AgentGuard
      // deterministically on the server, without asking the model, so the verdict is real.
      const proposeExcludedProduct = async (product: ExcludedShoppingProduct) => {
        if (!mandateId || product.source !== "demo") return null;
        const step = TOOL_STEPS.create_purchase_proposal!;
        progress.step({ ...step, status: "running" });
        const created = await operation("POST", "/api/proposals", {
          mandateId,
          source: "demo",
          productId: product.externalId,
          quantity: 1,
          requestKey: chat.requestKey,
        });
        const proposalId =
          isRecord(created) && isRecord(created.proposal) && typeof created.proposal.id === "string"
            ? created.proposal.id
            : null;
        if (!proposalId) {
          progress.step({ ...step, status: "failed" });
          return null;
        }
        const evaluated =
          isRecord(created) && isRecord(created.proposal) && created.proposal.status === "PROPOSED"
            ? await operation(
                "POST",
                `/api/proposals/${encodeURIComponent(proposalId)}/evaluate`,
                {},
              )
            : await operation("GET", `/api/proposals/${encodeURIComponent(proposalId)}`);
        if (operationFailures.length || !isRecord(evaluated)) {
          progress.step({ ...step, status: "failed" });
          return null;
        }
        await context.database.auditEvent.create({
          data: {
            userId: user.id,
            eventType: "PRODUCT_SELECTED",
            entityType: "PURCHASE_PROPOSAL",
            entityId: proposalId,
            payload: {
              proposalId,
              mandateId,
              source: "demo",
              quantity: 1,
              aiReason: "user_selected_mandate_excluded_product",
              queryHash: createHash("sha256").update(chat.message).digest("hex"),
            },
          },
        });
        steps.push({ name: "create_purchase_proposal", status: "completed" });
        progress.step({ ...step, status: "completed" });
        return evaluated;
      };
      const excludedReply = (
        product: ExcludedShoppingProduct,
        evaluated: Record<string, unknown>,
        productContext: string | null | undefined,
      ) => ({
        message: excludedProposalReply(product, evaluated),
        explanation: null,
        proposals: [evaluated],
        refundDraft: null,
        steps,
        excludedProducts: [],
        productContext: productContext ?? null,
      });
      let externalSelection: SafeProduct | null = null;
      const purchaseIntent = wantsPurchase(chat.message);
      const combinedChoice =
        purchaseIntent && previousExcluded.length
          ? selectedProduct(chat.message, [...(previousProducts ?? []), ...previousExcluded])
          : null;
      const excludedChoice = previousExcluded.find((product) => product === combinedChoice);
      if (excludedChoice && excludedChoice.source === "demo") {
        const evaluated = await proposeExcludedProduct(excludedChoice);
        const failed = operationFailures[0];
        if (failed) return rejected(failed);
        if (evaluated) return ok(excludedReply(excludedChoice, evaluated, chat.productContext));
      }
      const selection = excludedChoice
        ? excludedChoice.source === "channel3"
          ? excludedChoice
          : null
        : purchaseIntent
          ? selectedProduct(chat.message, previousProducts ?? [])
          : null;
      const checkoutStep = TOOL_STEPS.check_checkout_availability!;
      if (selection?.source === "channel3") {
        progress.step({ ...checkoutStep, status: "completed" });
        return ok({
          message: externalPurchaseReply(selection),
          explanation: null,
          proposals: [],
          refundDraft: null,
          steps: [{ name: "check_checkout_availability", status: "completed" }],
          productContext: chat.productContext,
        });
      }
      if (
        wantsPurchase(chat.message) &&
        previousProducts?.length &&
        previousProducts.every((product) => product.source === "channel3")
      ) {
        progress.step({ ...checkoutStep, status: "completed" });
        return ok({
          message:
            "These are external retailer listings, so MandatePay can’t buy them directly. Copy the exact product title, listed price and retailer from the previous results so I can identify the listing. You can also open its retailer link to check size, stock and the final total. No order or payment has been created.",
          explanation: null,
          proposals: [],
          refundDraft: null,
          steps: [{ name: "check_checkout_availability", status: "completed" }],
          productContext: chat.productContext,
        });
      }

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
                      recentProducts: (previousProducts ?? []).map(modelProduct),
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
          const eligible: SafeProduct[] = [];
          const excluded: ExcludedShoppingProduct[] = [];
          let injectionCount = 0;
          for (const raw of products) {
            const product = safeProduct(raw);
            if (!product) continue;
            // Screened from the provider's raw text, before any cleaning or truncation.
            const screen = listingScreen(raw);
            const injection = screen.risk === "malicious";
            const reasons = [
              ...(injection ? [INJECTION_EXCLUSION_REASON] : []),
              ...mandateExclusions(product, rules),
            ].slice(0, 8);
            if (reasons.length) {
              // Shown to the user with its reasons; never offered to the model as a candidate.
              if (injection) injectionCount += 1;
              excluded.push({
                ...product,
                description: null,
                reasons,
                ...(injection ? { promptInjection: true as const } : {}),
              });
              continue;
            }
            // The user's own price cap and the model's brand filter narrow eligible results.
            if (product.priceMinor > maximumPriceMinor) continue;
            if (
              parsed.brands.length &&
              (!product.brand ||
                !parsed.brands.some(
                  (brand) => brand.toLowerCase() === product.brand?.toLowerCase(),
                ))
            )
              continue;
            // Suspicious listing copy never reaches the model; AgentGuard re-screens any proposal.
            eligible.push(screen.risk === "none" ? product : { ...product, description: null });
          }
          request.log.info(
            {
              event: "shopping_search_filtered",
              retrievedCount: products.length,
              matchedCount: eligible.length,
              excludedCount: excluded.length,
              injectionCount,
            },
            "Shopping search restrictions applied",
          );
          for (const product of eligible) knownProducts.set(product.externalId, product);
          discoveredProducts = eligible;
          excludedProducts = excluded.sort((a, b) => a.priceMinor - b.priceMinor).slice(0, 8);
          discoveryFallback = isRecord(response) && response.fallback === true;
          comparedProducts = null;
          steps.push({ name: "search_products", status: "completed" });
          return {
            products: eligible.map(modelProduct),
            excludedByMandateCount: excluded.length,
            excludedForAgentInstructionsCount: injectionCount,
            excludedNote:
              "Listings outside the mandate, or whose text tries to instruct AI agents, are shown to the user separately by the server. They cannot be proposed through this tool.",
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
          return { product: modelProduct(product) };
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
            products: comparedProducts.map(modelProduct),
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
              product: modelProduct(product),
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
            requestKey: chat.requestKey,
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
          // AgentGuard ALLOW: the server may pay buyer-not-present with the user's saved
          // PayPal; it re-checks every condition itself. Ineligible proposals are unchanged.
          if (
            isRecord(actual.proposal) &&
            actual.proposal.status === "AUTHORIZED" &&
            isRecord(actual.decision) &&
            actual.decision.decision === "ALLOW"
          ) {
            const paid = await internalJSON(
              context,
              request,
              "POST",
              `/api/proposals/${encodeURIComponent(proposalId)}/autopay`,
              {},
            ).catch(() => null);
            const autopay = isRecord(paid) && isRecord(paid.autopay) ? paid.autopay : null;
            const payment = autopay && isRecord(autopay.payment) ? autopay.payment : null;
            actual = {
              ...actual,
              ...(isRecord(paid) && isRecord(paid.proposal) ? { proposal: paid.proposal } : {}),
              autopay: {
                outcome: typeof autopay?.outcome === "string" ? autopay.outcome : "UNKNOWN",
                reason: typeof autopay?.reason === "string" ? autopay.reason : null,
                paymentId: typeof payment?.id === "string" ? payment.id : null,
                paymentStatus: typeof payment?.status === "string" ? payment.status : null,
              },
            };
          }
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
                queryHash: createHash("sha256").update(chat.message).digest("hex"),
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
          { message: chat.message, now: agentStarted.toISOString() },
          traceShoppingTools(withProgress(tools, progress), toolFacts),
          { signal: progress.signal },
        );
      } catch (cause) {
        await persistAgentRun(context.database, {
          requestId: chat.requestKey,
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
        requestId: chat.requestKey,
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
      if (failedOperation) return rejected(failedOperation);
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
        (wantsPurchase(chat.message) ? selectedProduct(chat.message, discoveredProducts) : null);
      const searched = steps.some((step) => step.name === "search_products");
      const productContext =
        owner && searched
          ? (comparedProducts ?? discoveredProducts).length || excludedProducts.length
            ? signShoppingProducts(
                comparedProducts ?? discoveredProducts,
                owner,
                productContextSecret,
                excludedProducts,
              )
            : null
          : (chat.productContext ?? null);
      if (purchaseIntent && proposals.length === 0 && !refundDraft && excludedProducts.length) {
        const choice = selectedProduct(chat.message, [...discoveredProducts, ...excludedProducts]);
        const excludedSelection = excludedProducts.find((product) => product === choice);
        if (excludedSelection?.source === "demo") {
          const evaluated = await proposeExcludedProduct(excludedSelection);
          const failed = operationFailures[0];
          if (failed) return rejected(failed);
          if (evaluated) return ok(excludedReply(excludedSelection, evaluated, productContext));
        }
      }
      return ok({
        message:
          selectedExternal?.source === "channel3" && proposals.length === 0 && !refundDraft
            ? externalPurchaseReply(selectedExternal)
            : discoveryOnly
              ? discoveryReply(
                  rules,
                  comparedProducts ?? discoveredProducts,
                  comparedProducts !== null,
                  {
                    excludedCount: excludedProducts.length,
                    injectionCount: excludedProducts.filter((product) => product.promptInjection)
                      .length,
                    fallback: discoveryFallback,
                  },
                )
              : result.finalAIExplanation.text,
        explanation: discoveryOnly || externalSelection ? null : result.finalAIExplanation,
        proposals,
        refundDraft,
        steps,
        excludedProducts: searched ? excludedProducts : [],
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
              : progress.signal.aborted
                ? "SHOPPING_CLIENT_DISCONNECTED"
                : "SHOPPING_INTERNAL_ERROR",
          ...(cause instanceof OpenAIProviderError ? { providerStatus: cause.status } : {}),
          ...(cause instanceof ShoppingAgentError ? { tool: cause.toolName } : {}),
        },
        "Shopping request failed",
      );
      return safeErrorOutcome(cause);
    }
  }

  app.post("/api/agent/chat", async (request, reply) => {
    const admitted = await admitChat(request, reply);
    if (!admitted) return reply;
    const outcome = await runChat(request, admitted.user, admitted.body, ignoreProgress);
    return reply.status(outcome.status).send(outcome.body);
  });

  /**
   * The same chat run as POST /api/agent/chat, streamed as Server-Sent Events:
   * `step` events while tools run, then one `result` (the exact JSON body) or
   * `error` ({ status, code?, error }). Checks that fail before the run starts
   * keep their ordinary JSON status responses.
   */
  app.post("/api/agent/chat/stream", async (request, reply) => {
    const admitted = await admitChat(request, reply);
    if (!admitted) return reply;
    const disconnect = new AbortController();
    const stream = new PassThrough();
    let finished = false;
    const write = (chunk: string) => {
      if (!stream.destroyed && !stream.writableEnded) stream.write(chunk);
    };
    const onClose = () => {
      if (!finished) disconnect.abort();
    };
    reply.raw.once("close", onClose);
    const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
    heartbeat.unref();
    void reply
      .status(200)
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(stream);
    write(": stream-open\n\n");
    void (async () => {
      try {
        const outcome = await runChat(request, admitted.user, admitted.body, {
          signal: disconnect.signal,
          step: (event) => write(encodeChatEvent("step", event)),
        });
        if (disconnect.signal.aborted) return;
        write(encodeChatEvent("step", chatOutcomeStep(outcome)));
        write(
          outcome.status < 400
            ? encodeChatEvent("result", outcome.body)
            : encodeChatEvent("error", { status: outcome.status, ...outcome.body }),
        );
      } catch {
        write(
          encodeChatEvent("error", {
            status: 503,
            error: "Shopping agent is temporarily unavailable.",
          }),
        );
      } finally {
        finished = true;
        clearInterval(heartbeat);
        reply.raw.off("close", onClose);
        stream.end();
      }
    })();
    return reply;
  });
}
