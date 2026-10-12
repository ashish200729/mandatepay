import { z } from "zod";

/** Agent gateway path on the MandatePay API host. */
export const GATEWAY_PATH = "/api/agent-gateway/v1";
const TOKEN_PATTERN = /^mp_agent_[A-Za-z0-9_-]{43}$/u;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type ApiErrorCode =
  "AGENT_TOKEN_INVALID" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE" | (string & {});

/** A safe, user-presentable failure. It never contains the token or raw upstream bodies. */
export class MandatePayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MandatePayApiError";
  }
}

export function isAgentToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Reads `Authorization: Bearer mp_agent_…`; anything else is null. */
export function agentTokenFromAuthorization(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer[ ]+(\S+)$/iu.exec(value?.trim() ?? "");
  return match?.[1] && isAgentToken(match[1]) ? match[1] : null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalises MANDATEPAY_API_URL to the gateway base URL. Tokens are only ever
 * sent over HTTPS, except to a loopback development API.
 */
export function gatewayBaseUrl(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("MANDATEPAY_API_URL must be an absolute http(s) URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MANDATEPAY_API_URL must not contain credentials, a query or a fragment.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new Error("MANDATEPAY_API_URL must use https (http is allowed only for localhost).");
  }
  const path = url.pathname.replace(/\/+$/u, "").replace(new RegExp(`${GATEWAY_PATH}$`, "u"), "");
  return `${url.origin}${path}${GATEWAY_PATH}`;
}

const minor = z.number().int().nonnegative();
const nullableText = z.string().nullable();

const MandateSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  active: z.boolean(),
  version: z.number().int(),
  startsAt: z.string(),
  expiresAt: z.string(),
  summary: z.string(),
  rules: z.object({
    productIntent: z.string(),
    currency: z.string(),
    transactionLimitMinor: minor,
    autoSpendLimitMinor: minor,
    dailyLimitMinor: minor.nullable(),
    weeklyLimitMinor: minor.nullable(),
    monthlyLimitMinor: minor.nullable(),
    quantityLimit: z.number().int(),
    allowedBrands: z.array(z.string()),
    blockedBrands: z.array(z.string()),
    allowedCategories: z.array(z.string()),
    blockedCategories: z.array(z.string()),
    allowedConditions: z.array(z.string()),
    allowedMerchants: z.array(z.string()),
    blockedMerchants: z.array(z.string()),
    newMerchantRequiresApproval: z.boolean(),
  }),
});
export type Mandate = z.output<typeof MandateSchema>;

const ProductSchema = z.object({
  productId: z.string(),
  source: z.enum(["demo", "channel3"]),
  priceMinor: minor,
  currency: z.string(),
  price: z.string(),
  condition: z.string(),
  checkoutEligible: z.boolean(),
  productUrl: nullableText,
  listing: z.string(),
});
export type Product = z.output<typeof ProductSchema>;

export const ListMandatesResponse = z.object({ mandates: z.array(MandateSchema) });
export const GetMandateResponse = z.object({ mandate: MandateSchema });
export const SearchResponse = z.object({
  mandateId: z.string(),
  products: z.array(ProductSchema),
  excluded: z.array(
    ProductSchema.extend({ reasons: z.array(z.string()), promptInjection: z.boolean() }),
  ),
  aboveMaximumCount: z.number().int().nonnegative(),
  maximumPriceMinor: minor,
  maximumTotal: z.string(),
  priceBasis: z.string(),
  fallback: z.boolean(),
  notice: nullableText,
  untrustedData: z.string(),
});
export type SearchResult = z.output<typeof SearchResponse>;

const ExplanationSchema = z
  .object({
    decision: z.string(),
    headline: z.string(),
    summary: z.string(),
    approvalCanOverride: z.boolean(),
    checks: z.array(
      z.object({
        rule: z.string(),
        label: z.string(),
        status: z.string(),
        limit: nullableText,
        actual: nullableText,
        message: z.string(),
      }),
    ),
  })
  .nullable();

export const SimulationResponse = z.object({
  simulated: z.literal(true),
  decision: z.enum(["ALLOW", "REQUIRE_APPROVAL", "BLOCK"]),
  reasonCodes: z.array(z.string()),
  explanation: ExplanationSchema,
  mandate: z.object({ id: z.string(), version: z.number().int(), status: z.string() }),
  facts: z.object({
    subtotal: minor,
    total: minor,
    currency: z.string(),
    isNewMerchant: z.boolean(),
    newMerchantSource: z.string(),
  }),
});
export type SimulationResult = z.output<typeof SimulationResponse>;

const ProposalSchema = z.object({
  id: z.string(),
  status: z.string(),
  mandateId: z.string(),
  quantity: z.number().int(),
  totalMinor: minor,
  currency: z.string(),
  total: z.string(),
  product: z
    .object({
      title: z.string(),
      brand: nullableText,
      condition: z.string(),
      merchant: z.string(),
      source: z.string(),
    })
    .nullable(),
  expiresAt: nullableText,
  approvalExpiresAt: nullableText,
  createdAt: z.string(),
});
const DecisionSchema = z
  .object({
    decision: z.enum(["ALLOW", "REQUIRE_APPROVAL", "BLOCK"]),
    reasonCodes: z.array(z.string()),
    evaluatedAt: z.string(),
    explanation: ExplanationSchema,
  })
  .nullable();
const NextStepSchema = z.object({ action: z.string(), url: z.string(), message: z.string() });

export const ProposeResponse = z.object({
  proposal: ProposalSchema,
  decision: DecisionSchema,
  autopay: z
    .object({
      outcome: z.string(),
      reason: nullableText,
      paymentId: nullableText,
      paymentStatus: nullableText,
    })
    .nullable(),
  nextStep: NextStepSchema,
  authority: z.string(),
});
export type ProposeResult = z.output<typeof ProposeResponse>;

export const GetProposalResponse = z.object({
  proposal: ProposalSchema,
  decision: DecisionSchema,
  payment: z.object({ id: z.string(), status: z.string() }).nullable(),
  nextStep: NextStepSchema,
});
export type ProposalResult = z.output<typeof GetProposalResponse>;

export const OrderResponse = z.object({
  order: z.object({
    id: z.string(),
    proposalId: z.string(),
    status: z.string(),
    amountMinor: minor,
    currency: z.string(),
    amount: z.string(),
    capturedAt: nullableText,
    paymentSource: z.string(),
    url: z.string(),
  }),
});
export type OrderResult = z.output<typeof OrderResponse>;

export interface SearchInput {
  readonly mandateId: string;
  readonly query?: string | undefined;
  readonly maxPriceMinor?: number | undefined;
}
export interface SimulationInput {
  readonly price: number;
  readonly quantity?: number | undefined;
  readonly condition: "NEW" | "USED" | "REFURBISHED";
  readonly brand?: string | undefined;
  readonly category?: string | undefined;
  readonly merchant: string;
  readonly shipping?: number | undefined;
  readonly tax?: number | undefined;
}
export interface ProposeInput {
  readonly mandateId: string;
  readonly productId: string;
  readonly source: "demo" | "channel3";
  readonly quantity: number;
  readonly requestKey?: string | undefined;
}

export interface MandatePayClient {
  listMandates(): Promise<z.output<typeof ListMandatesResponse>>;
  getMandate(id: string): Promise<z.output<typeof GetMandateResponse>>;
  searchProducts(input: SearchInput): Promise<SearchResult>;
  simulatePurchase(mandateId: string, input: SimulationInput): Promise<SimulationResult>;
  proposePurchase(input: ProposeInput): Promise<ProposeResult>;
  getProposal(id: string): Promise<ProposalResult>;
  getOrderStatus(paymentId: string): Promise<OrderResult>;
}

export interface MandatePayClientOptions {
  /** MANDATEPAY_API_URL: the MandatePay API origin (the gateway path is appended). */
  readonly apiUrl: string;
  /** An `mp_agent_…` token created in MandatePay Settings. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Server-supplied messages are short single-line text; anything else is replaced. */
function safeMessage(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const line = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
  return line || fallback;
}

function statusFallback(status: number) {
  if (status === 401) return "The MandatePay agent token is invalid, expired or revoked.";
  if (status === 403) return "MandatePay refused this request.";
  if (status === 404) return "Not found in this MandatePay account.";
  if (status === 429) return "MandatePay is rate limiting this agent. Wait a minute and retry.";
  if (status >= 500) return "MandatePay is temporarily unavailable. Retry shortly.";
  return "MandatePay rejected the request.";
}

function segment(value: string) {
  return encodeURIComponent(value);
}

export function createMandatePayClient(options: MandatePayClientOptions): MandatePayClient {
  if (!isAgentToken(options.token)) {
    throw new Error("A MandatePay agent token (mp_agent_…) is required.");
  }
  const base = gatewayBaseUrl(options.apiUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetch ?? fetch;

  async function request<T extends z.ZodType>(
    schema: T,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<z.output<T>> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new MandatePayApiError(
        timedOut ? 504 : 503,
        timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        timedOut
          ? "MandatePay did not respond in time. Retry shortly."
          : "MandatePay could not be reached.",
      );
    }
    const text = await response.text().catch(() => "");
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new MandatePayApiError(502, "INVALID_RESPONSE", "MandatePay returned too much data.");
    }
    let payload: unknown = null;
    try {
      payload = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const record =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const code =
        typeof record.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(record.code)
          ? record.code
          : response.status === 401
            ? "AGENT_TOKEN_INVALID"
            : `HTTP_${response.status}`;
      throw new MandatePayApiError(
        response.status,
        code,
        safeMessage(record.error, statusFallback(response.status)),
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new MandatePayApiError(
        502,
        "INVALID_RESPONSE",
        "MandatePay returned a response this MCP server could not read.",
      );
    }
    return parsed.data;
  }

  return {
    listMandates: () => request(ListMandatesResponse, "GET", "/mandates"),
    getMandate: (id) => request(GetMandateResponse, "GET", `/mandates/${segment(id)}`),
    searchProducts: (input) =>
      request(SearchResponse, "POST", "/products/search", {
        mandateId: input.mandateId,
        ...(input.query ? { query: input.query } : {}),
        ...(input.maxPriceMinor === undefined ? {} : { maxPriceMinor: input.maxPriceMinor }),
      }),
    simulatePurchase: (mandateId, input) =>
      request(SimulationResponse, "POST", `/mandates/${segment(mandateId)}/simulate`, input),
    proposePurchase: (input) => request(ProposeResponse, "POST", "/proposals", input),
    getProposal: (id) => request(GetProposalResponse, "GET", `/proposals/${segment(id)}`),
    getOrderStatus: (paymentId) => request(OrderResponse, "GET", `/orders/${segment(paymentId)}`),
  };
}
