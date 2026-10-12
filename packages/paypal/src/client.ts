import { formatMinorUnits, toMinorUnits } from "@mandatepay/shared";
import { z } from "zod";
import {
  paypalEnvironmentHosts,
  parsePayPalConfig,
  type PayPalConfig,
  type PayPalEnvironmentHosts,
} from "./config.js";
import {
  PayPalError,
  PayPalInputError,
  PayPalProviderError,
  PayPalResponseError,
  PayPalWebhookError,
  isPayPalError,
  type PayPalErrorDetails,
} from "./errors.js";
import {
  OrderIdSchema,
  PayPalCaptureSchema,
  PayPalOrderSchema,
  PayPalRefundSchema,
  WebhookVerificationResponseSchema,
  parseCreateOrderInput,
  parseProviderMoney,
  parseRefundInput,
  parseVerifyWebhookInput,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalRefund,
} from "./types.js";
import {
  CreateVaultOrderInputSchema,
  CreateVaultPaymentTokenInputSchema,
  CreateVaultSetupTokenInputSchema,
  parsePaymentTokenResponse,
  parseSetupTokenResponse,
  parseVaultId,
  parseVaultInput,
  type PayPalVaultDeletion,
  type PayPalVaultPaymentToken,
  type PayPalVaultSetupToken,
} from "./vault.js";

const TokenResponseSchema = z
  .object({
    access_token: z.string().trim().min(1),
    token_type: z.string().trim().min(1),
    expires_in: z.number().positive(),
  })
  .passthrough();

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/u;
const DEBUG_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const BRAND_NAME = "MandatePay";

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

export interface PayPalClientOptions {
  readonly fetch?: typeof fetch;
  /** Replaces the retry backoff delay (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

function validateIdempotencyKey(value: string): string {
  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(38)
    .regex(/^[\x21-\x7E]+$/u)
    .safeParse(value);
  if (!parsed.success) throw new PayPalInputError("INVALID_IDEMPOTENCY_KEY");
  return parsed.data;
}

function validateOrderId(value: string): string {
  const parsed = OrderIdSchema.safeParse(value);
  if (!parsed.success) throw new PayPalInputError("INVALID_CAPTURE_INPUT");
  return parsed.data;
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value) ? value : null;
}

/**
 * Keeps only PayPal's machine-readable error name, first detail issue and
 * debug_id. Descriptions, messages and links are discarded.
 */
export function parsePayPalErrorBody(text: string): PayPalErrorDetails | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const details = Array.isArray(record.details) ? record.details : [];
  const first =
    typeof details[0] === "object" && details[0] !== null
      ? (details[0] as Record<string, unknown>)
      : null;
  const debugId =
    typeof record.debug_id === "string" && DEBUG_ID_PATTERN.test(record.debug_id)
      ? record.debug_id
      : null;
  const parsed = {
    name:
      safeCode(record.name) ??
      safeCode(typeof record.error === "string" ? record.error.toUpperCase() : null),
    issue: safeCode(first?.issue),
    debugId,
  };
  return parsed.name || parsed.issue || parsed.debugId ? parsed : null;
}

function isUncertainStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function approvalUrlFromOrder(
  order: z.output<typeof PayPalOrderSchema>,
  required: boolean,
  hosts: PayPalEnvironmentHosts,
): string | null {
  const href =
    order.links.find((link) => link.rel === "approve")?.href ??
    order.links.find((link) => link.rel === "payer-action")?.href;
  if (!href) {
    if (required) throw new PayPalResponseError("INVALID_APPROVAL_URL");
    return null;
  }

  try {
    const parsed = new URL(href);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      !hosts.approvalHosts.includes(parsed.hostname)
    ) {
      throw new Error("invalid approval host");
    }
  } catch {
    throw new PayPalResponseError("INVALID_APPROVAL_URL");
  }

  return href;
}

function parseOrderResponse(
  payload: unknown,
  requireApproval: boolean,
  hosts: PayPalEnvironmentHosts,
): PayPalOrder {
  const parsed = PayPalOrderSchema.safeParse(payload);
  if (!parsed.success) throw new PayPalResponseError("INVALID_ORDER_RESPONSE");
  for (const unit of parsed.data.purchase_units ?? []) {
    if (unit.amount !== undefined) parseProviderMoney(unit.amount);
    for (const capture of unit.payments?.captures ?? []) parseProviderMoney(capture.amount);
  }
  const approvalUrl = approvalUrlFromOrder(parsed.data, requireApproval, hosts);
  return Object.freeze({ ...parsed.data, approvalUrl });
}

function parseCaptureResponse(payload: unknown): PayPalCapture {
  const direct = PayPalCaptureSchema.safeParse(payload);
  if (direct.success) {
    parseProviderMoney(direct.data.amount);
    return Object.freeze(direct.data);
  }

  return extractCaptureFromOrder(payload);
}

export function extractCaptureFromOrder(payload: unknown): PayPalCapture {
  if (typeof payload !== "object" || payload === null) {
    throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  }
  const units = (payload as { purchase_units?: unknown }).purchase_units;
  if (!Array.isArray(units) || units.length !== 1) {
    throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  }
  const unit = units[0];
  if (typeof unit !== "object" || unit === null) {
    throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  }
  const payments = (unit as { payments?: unknown }).payments;
  if (typeof payments !== "object" || payments === null) {
    throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  }
  const captures = (payments as { captures?: unknown }).captures;
  if (!Array.isArray(captures) || captures.length !== 1) {
    throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  }
  const parsed = PayPalCaptureSchema.safeParse(captures[0]);
  if (!parsed.success) throw new PayPalResponseError("INVALID_CAPTURE_RESPONSE");
  parseProviderMoney(parsed.data.amount);
  return Object.freeze(parsed.data);
}

function parseRefundResponse(payload: unknown): PayPalRefund {
  const parsed = PayPalRefundSchema.safeParse(payload);
  if (!parsed.success) throw new PayPalResponseError("INVALID_REFUND_RESPONSE");
  parseProviderMoney(parsed.data.amount);
  return Object.freeze(parsed.data);
}

function money(minor: number) {
  return { currency_code: "USD", value: formatMinorUnits(toMinorUnits(minor)) };
}

interface PurchaseUnitInput {
  readonly amountMinor: number;
  readonly referenceId: string;
  readonly customId: string;
  readonly items?: readonly {
    name: string;
    sku?: string | undefined;
    quantity: number;
    unitAmountMinor: number;
  }[];
  readonly shippingMinor?: number;
  readonly taxMinor?: number;
}

/** One purchase unit with the exact server-owned breakdown (checkout and Vault orders). */
function purchaseUnits(parsed: PurchaseUnitInput) {
  const itemTotal = parsed.items?.reduce(
    (total, item) => total + item.unitAmountMinor * item.quantity,
    0,
  );
  return [
    {
      reference_id: parsed.referenceId,
      custom_id: parsed.customId,
      amount: {
        ...money(parsed.amountMinor),
        ...(parsed.items && itemTotal !== undefined
          ? {
              breakdown: {
                item_total: money(itemTotal),
                shipping: money(parsed.shippingMinor ?? 0),
                tax_total: money(parsed.taxMinor ?? 0),
              },
            }
          : {}),
      },
      ...(parsed.items
        ? {
            items: parsed.items.map((item) => ({
              name: item.name,
              quantity: String(item.quantity),
              unit_amount: money(item.unitAmountMinor),
              ...(item.sku ? { sku: item.sku } : {}),
            })),
          }
        : {}),
    },
  ];
}

interface JsonRequestOptions {
  readonly method: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  /** A pre-serialized JSON body sent byte-for-byte (webhook verification). */
  readonly rawJsonBody?: string;
  readonly requestId?: string;
  readonly mutation?: boolean;
  readonly preferRepresentation?: boolean;
}

export class PayPalClient {
  readonly config: PayPalConfig;
  readonly hosts: PayPalEnvironmentHosts;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private cachedToken: AccessToken | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(configInput: PayPalConfig, options: PayPalClientOptions = {}) {
    this.config = parsePayPalConfig(configInput);
    this.hosts = paypalEnvironmentHosts(this.config.environment);
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  /** The documented buyer redirect for an existing order in this environment. */
  checkoutUrl(orderId: string): string {
    const id = validateOrderId(orderId);
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(id)) throw new PayPalInputError("INVALID_CAPTURE_INPUT");
    return `https://${this.hosts.checkoutHost}/checkoutnow?token=${encodeURIComponent(id)}`;
  }

  /**
   * Confirms OAuth reachability. The access token is discarded and never
   * returned, logged, or copied into the result.
   */
  async probeSandbox(): Promise<{
    status: "ready" | "degraded" | "unavailable";
    code: string;
    latencyMs: number;
  }> {
    const started = Date.now();
    try {
      const token = await this.getAccessToken();
      if (typeof token !== "string" || token.length === 0) {
        return {
          status: "unavailable",
          code: "MALFORMED_RESPONSE",
          latencyMs: Date.now() - started,
        };
      }
      return { status: "ready", code: "PAYPAL_REACHABLE", latencyMs: Date.now() - started };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (error instanceof PayPalProviderError) {
        if (
          error.code === "UPSTREAM_TIMEOUT" ||
          error.code === "UPSTREAM_ABORTED" ||
          error.code === "UPSTREAM_UNAVAILABLE" ||
          error.status === 429
        ) {
          return {
            status: "degraded",
            code: error.status === 429 ? "UPSTREAM_UNAVAILABLE" : error.code,
            latencyMs,
          };
        }
        return { status: "unavailable", code: error.code, latencyMs };
      }
      if (isPayPalError(error)) return { status: "unavailable", code: error.code, latencyMs };
      return { status: "unavailable", code: "PROBE_FAILED", latencyMs };
    }
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 30_000) {
      return this.cachedToken.value;
    }
    if (this.pendingToken) return this.pendingToken;

    this.pendingToken = this.issueAccessToken();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = null;
    }
  }

  private async issueAccessToken(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
        "base64",
      );
      const response = await this.fetcher(`${this.hosts.apiBaseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PayPalProviderError(
          response.status === 401 ? "AUTHENTICATION_FAILED" : "UPSTREAM_REQUEST_FAILED",
          response.status,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PayPalProviderError("MALFORMED_RESPONSE");
      }
      const parsed = TokenResponseSchema.safeParse(body);
      if (!parsed.success) throw new PayPalProviderError("MALFORMED_RESPONSE");
      const token: AccessToken = {
        value: parsed.data.access_token,
        expiresAt: Date.now() + Math.max(0, parsed.data.expires_in * 1000 - 60_000),
      };
      this.cachedToken = token;
      return token.value;
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      if (controller.signal.aborted) {
        throw new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
          retryable: true,
        });
      }
      throw new PayPalProviderError("UPSTREAM_REQUEST_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sends one request with bounded retries. Only idempotent requests (GETs and
   * POSTs carrying a PayPal-Request-Id) are retried, and only after uncertain
   * failures. A 401 refreshes the token and repeats the request exactly once;
   * PayPal rejects it before processing, so the repeat cannot double-execute.
   */
  private async requestJson(path: string, options: JsonRequestOptions): Promise<unknown> {
    const requestId =
      options.requestId === undefined ? undefined : validateIdempotencyKey(options.requestId);
    // DELETE is idempotent by definition: repeating it cannot delete twice.
    const idempotent =
      options.method === "GET" || options.method === "DELETE" || requestId !== undefined;
    const maxRetries = idempotent ? this.config.maxRetries : 0;
    let authRetried = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(path, options, requestId);
      } catch (error) {
        if (
          !authRetried &&
          error instanceof PayPalProviderError &&
          error.code === "AUTHENTICATION_FAILED" &&
          error.status === 401
        ) {
          authRetried = true;
          this.invalidateAccessToken();
          attempt -= 1;
          continue;
        }
        if (attempt >= maxRetries || !this.retryable(error)) throw error;
        await this.sleep(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt));
      }
    }
  }

  private retryable(error: unknown): boolean {
    if (!(error instanceof PayPalProviderError)) return false;
    if (error.code === "UPSTREAM_TIMEOUT" || error.code === "MALFORMED_RESPONSE") return true;
    if (error.code === "UPSTREAM_UNAVAILABLE") return true;
    return error.code === "UPSTREAM_REQUEST_FAILED" && error.status === undefined;
  }

  private async requestOnce(
    path: string,
    options: JsonRequestOptions,
    requestId: string | undefined,
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const mutation = options.mutation === true;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (requestId) headers["PayPal-Request-Id"] = requestId;
      if (options.preferRepresentation) headers.Prefer = "return=representation";
      const response = await this.fetcher(`${this.hosts.apiBaseUrl}${path}`, {
        method: options.method,
        headers,
        body:
          options.rawJsonBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
        signal: controller.signal,
      });
      if (!response.ok) {
        let details: PayPalErrorDetails | null = null;
        try {
          details = parsePayPalErrorBody(await response.text());
        } catch {
          details = null;
        }
        if (response.status === 401) {
          this.invalidateAccessToken();
          throw new PayPalProviderError("AUTHENTICATION_FAILED", 401, { details });
        }
        const uncertain = isUncertainStatus(response.status);
        throw new PayPalProviderError(
          uncertain ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REQUEST_FAILED",
          response.status,
          { retryable: uncertain, unknownOutcome: uncertain && mutation, details },
        );
      }
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        throw new PayPalProviderError("MALFORMED_RESPONSE", undefined, {
          unknownOutcome: mutation,
        });
      }
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      if (controller.signal.aborted) {
        throw new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
          retryable: true,
          unknownOutcome: mutation,
        });
      }
      throw new PayPalProviderError("UPSTREAM_REQUEST_FAILED", undefined, {
        retryable: true,
        unknownOutcome: mutation,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async createOrder(input: unknown): Promise<PayPalOrder> {
    const parsed = parseCreateOrderInput(input);
    if (
      this.config.environment === "live" &&
      [parsed.returnUrl, parsed.cancelUrl].some((url) => !url.startsWith("https://"))
    ) {
      throw new PayPalInputError("INVALID_ORDER_INPUT");
    }
    const payload = {
      intent: "CAPTURE",
      purchase_units: purchaseUnits(parsed),
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: BRAND_NAME,
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: parsed.returnUrl,
            cancel_url: parsed.cancelUrl,
          },
        },
      },
    };
    const response = await this.requestJson("/v2/checkout/orders", {
      method: "POST",
      body: payload,
      requestId: parsed.requestId,
      mutation: true,
      preferRepresentation: true,
    });
    return parseOrderResponse(response, true, this.hosts);
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    const id = validateOrderId(orderId);
    const response = await this.requestJson(`/v2/checkout/orders/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parseOrderResponse(response, false, this.hosts);
  }

  async captureOrder(orderId: string, requestId: string): Promise<PayPalCapture> {
    const id = validateOrderId(orderId);
    const key = validateIdempotencyKey(requestId);
    const response = await this.requestJson(
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      { method: "POST", body: {}, requestId: key, mutation: true, preferRepresentation: true },
    );
    return parseCaptureResponse(response);
  }

  async getCapture(captureId: string): Promise<PayPalCapture> {
    const id = validateOrderId(captureId);
    const response = await this.requestJson(`/v2/payments/captures/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parseCaptureResponse(response);
  }

  async refundCapture(input: unknown): Promise<PayPalRefund> {
    const parsed = parseRefundInput(input);
    // Full and partial refunds both keep the local binding and payer note.
    const body = {
      ...(parsed.amountMinor === null ? {} : { amount: money(parsed.amountMinor) }),
      ...(parsed.invoiceId ? { invoice_id: parsed.invoiceId } : {}),
      ...(parsed.reason ? { note_to_payer: parsed.reason } : {}),
    };
    const response = await this.requestJson(
      `/v2/payments/captures/${encodeURIComponent(parsed.captureId)}/refund`,
      {
        method: "POST",
        body,
        requestId: parsed.requestId,
        mutation: true,
        preferRepresentation: true,
      },
    );
    // Hydrate a minimal successful response without submitting another refund.
    const candidate = PayPalRefundSchema.safeParse(response);
    if (!candidate.success || !candidate.data.create_time) {
      const identity = z
        .object({ id: z.string().regex(/^[A-Za-z0-9-]{1,50}$/u) })
        .safeParse(response);
      if (!identity.success) throw new PayPalResponseError("INVALID_REFUND_RESPONSE");
      return this.getRefund(identity.data.id);
    }
    return parseRefundResponse(response);
  }

  async getRefund(refundId: string): Promise<PayPalRefund> {
    const id = validateOrderId(refundId);
    const response = await this.requestJson(`/v2/payments/refunds/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parseRefundResponse(response);
  }

  /**
   * Starts PayPal Vault consent without a purchase (POST /v3/vault/setup-tokens).
   * The buyer must approve the returned link before a payment token exists.
   */
  async createVaultSetupToken(input: unknown): Promise<PayPalVaultSetupToken> {
    const parsed = parseVaultInput(CreateVaultSetupTokenInputSchema, input);
    if (
      this.config.environment === "live" &&
      [parsed.returnUrl, parsed.cancelUrl].some((url) => !url.startsWith("https://"))
    ) {
      throw new PayPalInputError("INVALID_VAULT_INPUT");
    }
    const response = await this.requestJson("/v3/vault/setup-tokens", {
      method: "POST",
      body: {
        payment_source: {
          paypal: {
            description: parsed.description,
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: {
              brand_name: BRAND_NAME,
              locale: "en-US",
              shipping_preference: "NO_SHIPPING",
              return_url: parsed.returnUrl,
              cancel_url: parsed.cancelUrl,
            },
          },
        },
      },
      requestId: parsed.requestId,
      mutation: true,
    });
    return parseSetupTokenResponse(response, this.hosts.approvalHosts);
  }

  /** Exchanges a buyer-approved setup token for a reusable payment token. */
  async createVaultPaymentToken(input: unknown): Promise<PayPalVaultPaymentToken> {
    const parsed = parseVaultInput(CreateVaultPaymentTokenInputSchema, input);
    const response = await this.requestJson("/v3/vault/payment-tokens", {
      method: "POST",
      body: { payment_source: { token: { id: parsed.setupTokenId, type: "SETUP_TOKEN" } } },
      requestId: parsed.requestId,
      mutation: true,
    });
    return parsePaymentTokenResponse(response);
  }

  async getVaultPaymentToken(paymentTokenId: string): Promise<PayPalVaultPaymentToken> {
    const id = parseVaultId(paymentTokenId);
    const response = await this.requestJson(`/v3/vault/payment-tokens/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parsePaymentTokenResponse(response);
  }

  /** Deletes a payment token. A 404 means it is already gone and counts as removed. */
  async deleteVaultPaymentToken(paymentTokenId: string): Promise<PayPalVaultDeletion> {
    const id = parseVaultId(paymentTokenId);
    try {
      await this.requestJson(`/v3/vault/payment-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
        mutation: true,
      });
      return { alreadyAbsent: false };
    } catch (error) {
      if (error instanceof PayPalProviderError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      throw error;
    }
  }

  /**
   * Creates a buyer-not-present CAPTURE order charged to a saved payment token.
   * PayPal commonly completes the capture in this response; the caller must
   * still handle APPROVED, PAYER_ACTION_REQUIRED and uncertain outcomes.
   */
  async createVaultOrder(input: unknown): Promise<PayPalOrder> {
    const parsed = parseVaultInput(CreateVaultOrderInputSchema, input);
    const response = await this.requestJson("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: purchaseUnits(parsed),
        payment_source: { paypal: { vault_id: parsed.vaultId } },
      },
      requestId: parsed.requestId,
      mutation: true,
      preferRepresentation: true,
    });
    return parseOrderResponse(response, false, this.hosts);
  }

  /**
   * PayPal verifies the signature over the exact delivered bytes, so the raw
   * body is embedded unmodified inside the verification payload instead of
   * being parsed and re-serialized.
   */
  async verifyWebhook(input: unknown): Promise<boolean> {
    const parsed = parseVerifyWebhookInput(input);
    if (this.config.webhookId === null) throw new PayPalWebhookError("MISSING_WEBHOOK_ID");

    let event: unknown;
    try {
      event = JSON.parse(parsed.rawBody);
    } catch {
      throw new PayPalWebhookError("INVALID_WEBHOOK_INPUT");
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw new PayPalWebhookError("INVALID_WEBHOOK_INPUT");
    }

    const fields = JSON.stringify({
      auth_algo: parsed.headers.authAlgo,
      cert_url: parsed.headers.certUrl,
      transmission_id: parsed.headers.transmissionId,
      transmission_sig: parsed.headers.transmissionSig,
      transmission_time: parsed.headers.transmissionTime,
      webhook_id: this.config.webhookId,
    });
    const rawJsonBody = `${fields.slice(0, -1)},"webhook_event":${parsed.rawBody}}`;
    const response = await this.requestJson("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      rawJsonBody,
    });
    const verification = WebhookVerificationResponseSchema.safeParse(response);
    if (!verification.success) throw new PayPalWebhookError("INVALID_WEBHOOK_SIGNATURE_RESPONSE");
    return verification.data.verification_status === "SUCCESS";
  }
}
