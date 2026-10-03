import { formatMinorUnits } from "@mandatepay/shared";
import { z } from "zod";
import { PAYPAL_SANDBOX_BASE_URL, parsePayPalConfig, type PayPalConfig } from "./config.js";
import {
  PayPalError,
  PayPalInputError,
  PayPalProviderError,
  PayPalResponseError,
  PayPalWebhookError,
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

const TokenResponseSchema = z
  .object({
    access_token: z.string().trim().min(1),
    token_type: z.string().trim().min(1),
    expires_in: z.number().positive(),
  })
  .passthrough();

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

export interface PayPalClientOptions {
  readonly fetch?: typeof fetch;
}

function validateIdempotencyKey(value: string): string {
  const parsed = z.string().trim().min(1).max(100).safeParse(value);
  if (!parsed.success) throw new PayPalInputError("INVALID_IDEMPOTENCY_KEY");
  return parsed.data;
}

function validateOrderId(value: string): string {
  const parsed = OrderIdSchema.safeParse(value);
  if (!parsed.success) throw new PayPalInputError("INVALID_CAPTURE_INPUT");
  return parsed.data;
}

function approvalUrlFromOrder(
  order: z.output<typeof PayPalOrderSchema>,
  required: boolean,
): string | null {
  const href = order.links.find((link) => link.rel === "approve")?.href;
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
      !(parsed.hostname === "sandbox.paypal.com" || parsed.hostname === "www.sandbox.paypal.com")
    ) {
      throw new Error("invalid approval host");
    }
  } catch {
    throw new PayPalResponseError("INVALID_APPROVAL_URL");
  }

  return href;
}

function parseOrderResponse(payload: unknown, requireApproval: boolean): PayPalOrder {
  const parsed = PayPalOrderSchema.safeParse(payload);
  if (!parsed.success) throw new PayPalResponseError("INVALID_ORDER_RESPONSE");
  for (const unit of parsed.data.purchase_units ?? []) {
    if (unit.amount !== undefined) parseProviderMoney(unit.amount);
    for (const capture of unit.payments?.captures ?? []) parseProviderMoney(capture.amount);
  }
  const approvalUrl = approvalUrlFromOrder(parsed.data, requireApproval);
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

export class PayPalClient {
  readonly config: PayPalConfig;
  private readonly fetcher: typeof fetch;
  private cachedToken: AccessToken | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(configInput: PayPalConfig, options: PayPalClientOptions = {}) {
    this.config = parsePayPalConfig(configInput);
    this.fetcher = options.fetch ?? fetch;
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
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
      const response = await this.fetcher(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
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

  private async requestJson(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      requestId?: string;
      mutation?: boolean;
      preferRepresentation?: boolean;
    },
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (options.requestId)
        headers["PayPal-Request-Id"] = validateIdempotencyKey(options.requestId);
      if (options.preferRepresentation) headers.Prefer = "return=representation";
      const response = await this.fetcher(`${PAYPAL_SANDBOX_BASE_URL}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const uncertain =
          options.mutation === true &&
          (response.status === 408 ||
            response.status === 409 ||
            response.status === 429 ||
            response.status >= 500);
        throw new PayPalProviderError(
          uncertain ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REQUEST_FAILED",
          response.status,
          { retryable: uncertain, unknownOutcome: uncertain },
        );
      }
      try {
        return await response.json();
      } catch {
        throw new PayPalProviderError("MALFORMED_RESPONSE", undefined, {
          unknownOutcome: options.mutation === true,
        });
      }
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      if (controller.signal.aborted) {
        throw new PayPalProviderError("UPSTREAM_TIMEOUT", undefined, {
          retryable: true,
          unknownOutcome: options.mutation === true,
        });
      }
      throw new PayPalProviderError("UPSTREAM_REQUEST_FAILED", undefined, {
        unknownOutcome: options.mutation === true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async createOrder(input: unknown): Promise<PayPalOrder> {
    const parsed = parseCreateOrderInput(input);
    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: parsed.referenceId,
          custom_id: parsed.customId,
          amount: { currency_code: "USD", value: formatMinorUnits(parsed.amountMinor) },
        },
      ],
      application_context: {
        return_url: parsed.returnUrl,
        cancel_url: parsed.cancelUrl,
        user_action: "PAY_NOW",
      },
    };
    const response = await this.requestJson("/v2/checkout/orders", {
      method: "POST",
      body: payload,
      requestId: parsed.requestId,
      mutation: true,
      preferRepresentation: true,
    });
    return parseOrderResponse(response, true);
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    const id = validateOrderId(orderId);
    const response = await this.requestJson(`/v2/checkout/orders/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parseOrderResponse(response, false);
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
    const body =
      parsed.amountMinor === null
        ? {}
        : {
            amount: { currency_code: "USD", value: formatMinorUnits(parsed.amountMinor) },
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
    return parseRefundResponse(response);
  }

  async getRefund(refundId: string): Promise<PayPalRefund> {
    const id = validateOrderId(refundId);
    const response = await this.requestJson(`/v2/payments/refunds/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return parseRefundResponse(response);
  }

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

    const response = await this.requestJson("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: parsed.headers.authAlgo,
        cert_url: parsed.headers.certUrl,
        transmission_id: parsed.headers.transmissionId,
        transmission_sig: parsed.headers.transmissionSig,
        transmission_time: parsed.headers.transmissionTime,
        webhook_id: this.config.webhookId,
        webhook_event: event,
      },
    });
    const verification = WebhookVerificationResponseSchema.safeParse(response);
    if (!verification.success) throw new PayPalWebhookError("INVALID_WEBHOOK_SIGNATURE_RESPONSE");
    return verification.data.verification_status === "SUCCESS";
  }
}
