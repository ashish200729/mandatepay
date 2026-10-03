import { z } from "zod";
import { PayPalError, PayPalProviderError, PayPalWebhookError } from "./errors.js";
import type { PayPalCapture, PayPalOrder, PayPalRefund, WebhookHeaders } from "./types.js";
import { PayPalClient } from "./client.js";

export const PAYPAL_WEBHOOK_PATH = "/api/webhooks/paypal";
export const DEFAULT_WEBHOOK_BODY_LIMIT = 1_000_000;

const webhookResourceSchema = z.record(z.string(), z.unknown());
export const PayPalWebhookEventSchema = z
  .object({
    id: z.string().trim().min(1),
    event_type: z.string().trim().min(1),
    resource: webhookResourceSchema,
  })
  .passthrough();

export type PayPalWebhookEvent = z.output<typeof PayPalWebhookEventSchema>;

export type WebhookProcessingResult = "processed" | "pending" | "ignored";

export interface WebhookInboxClaim {
  readonly id: string;
  readonly shouldProcess: boolean;
  readonly status: "RECEIVED" | "PROCESSING" | "PENDING" | "PROCESSED" | "IGNORED";
}

export interface WebhookInboxStore {
  /** Atomically upsert the provider/event key and claim it under a transaction lock. */
  claim(input: {
    provider: "paypal";
    providerEventId: string;
    eventType: string;
    payload: PayPalWebhookEvent;
  }): Promise<WebhookInboxClaim>;
  markProcessed(id: string): Promise<void>;
  markPending(id: string, reason: string): Promise<void>;
  markIgnored(id: string, reason: string): Promise<void>;
}

export interface VerifiedWebhookReplayInput {
  readonly inboxId: string;
  readonly event: unknown;
}

export type AuthoritativeWebhookData =
  | { readonly kind: "order"; readonly order: PayPalOrder }
  | {
      readonly kind: "capture";
      readonly capture: PayPalCapture;
      readonly order: PayPalOrder | null;
    }
  | {
      readonly kind: "refund";
      readonly refund: PayPalRefund;
      readonly capture: PayPalCapture | null;
      readonly order: PayPalOrder | null;
    };

export interface PayPalWebhookReconciler {
  /** Performs ownership, proposal binding, amount/currency checks, and one DB transaction. */
  reconcile(input: {
    event: PayPalWebhookEvent;
    authoritative: AuthoritativeWebhookData;
  }): Promise<WebhookProcessingResult>;
}

export interface PayPalWebhookServiceOptions {
  readonly bodyLimitBytes?: number;
}

export interface RawPayPalWebhookRequest {
  readonly rawBody?: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface WebhookServiceResponse {
  readonly statusCode: 200 | 202 | 400 | 401 | 413 | 415 | 503;
  readonly body: Record<string, unknown>;
}

function header(headers: RawPayPalWebhookRequest["headers"], name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
}

function webhookHeaders(request: RawPayPalWebhookRequest): WebhookHeaders | null {
  const values = {
    transmissionId: header(request.headers, "paypal-transmission-id"),
    transmissionTime: header(request.headers, "paypal-transmission-time"),
    certUrl: header(request.headers, "paypal-cert-url"),
    authAlgo: header(request.headers, "paypal-auth-algo"),
    transmissionSig: header(request.headers, "paypal-transmission-sig"),
  };
  if (Object.values(values).some((value) => typeof value !== "string" || !value.trim()))
    return null;
  return values as WebhookHeaders;
}

function parseEvent(rawBody: string): PayPalWebhookEvent | null {
  try {
    const parsed = PayPalWebhookEventSchema.safeParse(JSON.parse(rawBody));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(value: unknown, key: string): string | null {
  return typeof record(value)?.[key] === "string" ? (record(value)?.[key] as string) : null;
}

function relatedId(resource: Record<string, unknown>, key: string): string | null {
  const supplementary = record(resource.supplementary_data);
  const related = record(supplementary?.related_ids);
  return stringAt(related, key);
}

function relatedOrderId(resource: Record<string, unknown>): string | null {
  return relatedId(resource, "order_id") ?? stringAt(resource, "order_id");
}

function relatedCaptureId(resource: Record<string, unknown>): string | null {
  return relatedId(resource, "capture_id") ?? stringAt(resource, "capture_id");
}

function providerErrorResponse(error: unknown): WebhookServiceResponse {
  if (error instanceof PayPalWebhookError) {
    if (error.code === "INVALID_WEBHOOK_INPUT") {
      return { statusCode: 400, body: { error: "Webhook signature input is invalid." } };
    }
    if (error.code === "MISSING_WEBHOOK_ID") {
      return { statusCode: 503, body: { error: "Webhook verification is unavailable." } };
    }
    return { statusCode: 503, body: { error: "Webhook verification is unavailable." } };
  }
  if (error instanceof PayPalProviderError || error instanceof PayPalError) {
    return { statusCode: 503, body: { error: "PayPal webhook verification is unavailable." } };
  }
  return { statusCode: 503, body: { error: "Webhook processing is temporarily unavailable." } };
}

export class PayPalWebhookService {
  private readonly bodyLimitBytes: number;

  constructor(
    private readonly paypal: PayPalClient,
    private readonly inbox: WebhookInboxStore,
    private readonly reconciler: PayPalWebhookReconciler,
    options: PayPalWebhookServiceOptions = {},
  ) {
    this.bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  }

  async handle(request: RawPayPalWebhookRequest): Promise<WebhookServiceResponse> {
    if (typeof request.rawBody !== "string") {
      return { statusCode: 400, body: { error: "Webhook body must be raw JSON text." } };
    }
    if (Buffer.byteLength(request.rawBody, "utf8") > this.bodyLimitBytes) {
      return { statusCode: 413, body: { error: "Webhook body is too large." } };
    }

    const headers = webhookHeaders(request);
    if (!headers) {
      return { statusCode: 400, body: { error: "Required PayPal webhook headers are missing." } };
    }

    let verified: boolean;
    try {
      verified = await this.paypal.verifyWebhook({ rawBody: request.rawBody, headers });
    } catch (error) {
      return providerErrorResponse(error);
    }
    if (!verified) {
      return { statusCode: 401, body: { error: "PayPal webhook signature is invalid." } };
    }

    const event = parseEvent(request.rawBody);
    if (!event) {
      return { statusCode: 400, body: { error: "PayPal webhook event is invalid." } };
    }

    const claim = await this.inbox.claim({
      provider: "paypal",
      providerEventId: event.id,
      eventType: event.event_type,
      payload: event,
    });
    if (!claim.shouldProcess) {
      if (claim.status === "PROCESSING") {
        return { statusCode: 503, body: { error: "Webhook processing is already in progress." } };
      }
      return {
        statusCode: claim.status === "PENDING" ? 202 : 200,
        body: { status: claim.status === "PENDING" ? "pending" : "duplicate" },
      };
    }

    try {
      const outcome = await this.replayVerified({ inboxId: claim.id, event });
      if (outcome === "processed") {
        await this.inbox.markProcessed(claim.id);
        return { statusCode: 200, body: { status: "processed" } };
      }
      if (outcome === "ignored") {
        await this.inbox.markIgnored(claim.id, "Unsupported or unmatched verified PayPal event.");
        return { statusCode: 200, body: { status: "ignored" } };
      }
      await this.inbox.markPending(claim.id, "Payment binding or provider state is not ready.");
      return { statusCode: 202, body: { status: "pending" } };
    } catch {
      await this.inbox.markPending(claim.id, "Provider state could not be reconciled.");
      return { statusCode: 503, body: { error: "Webhook processing is temporarily unavailable." } };
    }
  }

  /**
   * Replays a payload that was already signature-verified and persisted by the
   * inbox. The caller owns its lease and must atomically persist the outcome.
   * This method never releases the lease while a worker is scheduling backoff.
   */
  async replayVerified(input: VerifiedWebhookReplayInput): Promise<WebhookProcessingResult> {
    const parsed = PayPalWebhookEventSchema.safeParse(input.event);
    if (!parsed.success) return "ignored";
    const authoritative = await this.authoritative(parsed.data.event_type, parsed.data.resource);
    if (!authoritative) return "ignored";
    return this.reconciler.reconcile({ event: parsed.data, authoritative });
  }

  private async authoritative(
    eventType: string,
    resource: Record<string, unknown>,
  ): Promise<AuthoritativeWebhookData | null> {
    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      const orderId = stringAt(resource, "id");
      if (!orderId) return null;
      return { kind: "order", order: await this.paypal.getOrder(orderId) };
    }

    if (eventType === "PAYMENT.CAPTURE.COMPLETED" || eventType === "PAYMENT.CAPTURE.DENIED") {
      const captureId = stringAt(resource, "id");
      if (!captureId) return null;
      const orderId = relatedOrderId(resource);
      return {
        kind: "capture",
        capture: await this.paypal.getCapture(captureId),
        order: orderId ? await this.paypal.getOrder(orderId) : null,
      };
    }

    if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      const refundId = stringAt(resource, "id");
      if (!refundId) return null;
      const captureId = relatedCaptureId(resource);
      const orderId = relatedOrderId(resource);
      return {
        kind: "refund",
        refund: await this.paypal.getRefund(refundId),
        capture: captureId ? await this.paypal.getCapture(captureId) : null,
        order: orderId ? await this.paypal.getOrder(orderId) : null,
      };
    }

    return null;
  }
}

export interface RawWebhookRouteRequest {
  readonly rawBody?: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface WebhookRouteReply {
  status(code: number): WebhookRouteReply;
  send(body: Record<string, unknown>): unknown;
}

export interface WebhookRouteApp {
  post(
    path: typeof PAYPAL_WEBHOOK_PATH,
    handler: (request: RawWebhookRouteRequest, reply: WebhookRouteReply) => Promise<unknown>,
  ): void;
}

export function registerPayPalWebhookRoute(
  app: WebhookRouteApp,
  service: PayPalWebhookService,
): void {
  app.post(PAYPAL_WEBHOOK_PATH, async (request, reply) => {
    const result = await service.handle({ rawBody: request.rawBody, headers: request.headers });
    return reply.status(result.statusCode).send(result.body);
  });
}
