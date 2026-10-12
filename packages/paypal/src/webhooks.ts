import { z } from "zod";
import { PayPalError, PayPalProviderError, PayPalWebhookError } from "./errors.js";
import type { PayPalCapture, PayPalOrder, PayPalRefund, WebhookHeaders } from "./types.js";
import { PayPalClient } from "./client.js";
import { PAYPAL_ENVIRONMENTS } from "./config.js";
import { VaultIdSchema, type PayPalVaultPaymentToken } from "./vault.js";

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
  /** Provider state or payment binding is not ready yet; retry on a long schedule. */
  markPending(id: string, reason: string): Promise<void>;
  markIgnored(id: string, reason: string): Promise<void>;
  /** Processing failed (for example PayPal was unreachable); retry on the failure schedule. */
  markFailed?(id: string, reason: string): Promise<void>;
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
    }
  | {
      /** A chargeback or other provider reversal of a completed capture. */
      readonly kind: "reversal";
      readonly capture: PayPalCapture;
      readonly refund: PayPalRefund | null;
      readonly order: PayPalOrder | null;
    }
  | {
      /** A Vault payment token event, re-read from PayPal. */
      readonly kind: "payment_token";
      readonly eventType: (typeof VAULT_PAYMENT_TOKEN_EVENTS)[number];
      readonly tokenId: string;
      /** The token as PayPal reports it now; null when PayPal confirms it no longer exists. */
      readonly token: PayPalVaultPaymentToken | null;
    };

/** Verified Vault events: a token saved or deleted (for example revoked by the buyer in PayPal). */
export const VAULT_PAYMENT_TOKEN_EVENTS = [
  "VAULT.PAYMENT-TOKEN.CREATED",
  "VAULT.PAYMENT-TOKEN.DELETED",
] as const;

/** Verified event types that are fetched from PayPal and reconciled. */
export const SUPPORTED_PAYPAL_WEBHOOK_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  ...VAULT_PAYMENT_TOKEN_EVENTS,
] as const;

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

export interface WebhookDeliveryFact {
  readonly outcome: "REJECTED" | "ACCEPTED" | "DUPLICATE";
  readonly eventType: string | null;
  readonly inboxId: string | null;
}

export interface WebhookServiceResponse {
  readonly statusCode: 200 | 202 | 400 | 401 | 413 | 415 | 503;
  readonly body: Record<string, unknown>;
  readonly delivery: WebhookDeliveryFact;
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

function linkedId(
  resource: Record<string, unknown>,
  path: string,
  hosts: readonly string[],
): string | null {
  if (!Array.isArray(resource.links)) return null;
  for (const link of resource.links) {
    const entry = record(link);
    if (entry?.rel !== "up" || typeof entry.href !== "string") continue;
    try {
      const url = new URL(entry.href);
      if (
        url.protocol !== "https:" ||
        !hosts.includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      )
        continue;
      const match = url.pathname.match(new RegExp(`^${path}/([A-Za-z0-9-]{1,50})$`, "u"));
      if (match?.[1]) return match[1];
    } catch {
      // Extract a bounded ID only; never request the supplied link URL.
    }
  }
  return null;
}

function relatedOrderId(
  resource: Record<string, unknown>,
  hosts: readonly string[],
): string | null {
  return (
    relatedId(resource, "order_id") ??
    stringAt(resource, "order_id") ??
    linkedId(resource, "/v2/checkout/orders", hosts)
  );
}

function relatedCaptureId(
  resource: Record<string, unknown>,
  hosts: readonly string[],
): string | null {
  return (
    relatedId(resource, "capture_id") ??
    stringAt(resource, "capture_id") ??
    linkedId(resource, "/v2/payments/captures", hosts)
  );
}

function delivery(
  outcome: WebhookDeliveryFact["outcome"],
  eventType: string | null,
  inboxId: string | null,
): WebhookDeliveryFact {
  return { outcome, eventType, inboxId };
}

function providerErrorResponse(error: unknown): WebhookServiceResponse {
  const rejected = delivery("REJECTED", null, null);
  if (error instanceof PayPalWebhookError) {
    if (error.code === "INVALID_WEBHOOK_INPUT") {
      return {
        statusCode: 400,
        body: { error: "Webhook signature input is invalid." },
        delivery: rejected,
      };
    }
    if (error.code === "MISSING_WEBHOOK_ID") {
      return {
        statusCode: 503,
        body: { error: "Webhook verification is unavailable." },
        delivery: rejected,
      };
    }
    return {
      statusCode: 503,
      body: { error: "Webhook verification is unavailable." },
      delivery: rejected,
    };
  }
  if (error instanceof PayPalProviderError || error instanceof PayPalError) {
    return {
      statusCode: 503,
      body: { error: "PayPal webhook verification is unavailable." },
      delivery: rejected,
    };
  }
  return {
    statusCode: 503,
    body: { error: "Webhook processing is temporarily unavailable." },
    delivery: rejected,
  };
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
    const rejected = delivery("REJECTED", null, null);
    if (typeof request.rawBody !== "string") {
      return {
        statusCode: 400,
        body: { error: "Webhook body must be raw JSON text." },
        delivery: rejected,
      };
    }
    if (Buffer.byteLength(request.rawBody, "utf8") > this.bodyLimitBytes) {
      return { statusCode: 413, body: { error: "Webhook body is too large." }, delivery: rejected };
    }

    const headers = webhookHeaders(request);
    if (!headers) {
      return {
        statusCode: 400,
        body: { error: "Required PayPal webhook headers are missing." },
        delivery: rejected,
      };
    }

    let verified: boolean;
    try {
      verified = await this.paypal.verifyWebhook({ rawBody: request.rawBody, headers });
    } catch (error) {
      return providerErrorResponse(error);
    }
    if (!verified) {
      return {
        statusCode: 401,
        body: { error: "PayPal webhook signature is invalid." },
        delivery: rejected,
      };
    }

    const event = parseEvent(request.rawBody);
    if (!event) {
      return {
        statusCode: 400,
        body: { error: "PayPal webhook event is invalid." },
        delivery: rejected,
      };
    }

    const claim = await this.inbox.claim({
      provider: "paypal",
      providerEventId: event.id,
      eventType: event.event_type,
      payload: event,
    });
    if (!claim.shouldProcess) {
      if (claim.status === "PROCESSING") {
        return {
          statusCode: 503,
          body: { error: "Webhook processing is already in progress." },
          delivery: delivery("DUPLICATE", event.event_type, claim.id),
        };
      }
      return {
        statusCode: claim.status === "PENDING" ? 202 : 200,
        body: { status: claim.status === "PENDING" ? "pending" : "duplicate" },
        delivery: delivery(
          claim.status === "PENDING" ? "ACCEPTED" : "DUPLICATE",
          event.event_type,
          claim.id,
        ),
      };
    }

    const accepted = delivery("ACCEPTED", event.event_type, claim.id);
    try {
      const outcome = await this.replayVerified({ inboxId: claim.id, event });
      if (outcome === "processed") {
        await this.inbox.markProcessed(claim.id);
        return { statusCode: 200, body: { status: "processed" }, delivery: accepted };
      }
      if (outcome === "ignored") {
        await this.inbox.markIgnored(claim.id, "Unsupported or unmatched verified PayPal event.");
        return { statusCode: 200, body: { status: "ignored" }, delivery: accepted };
      }
      await this.inbox.markPending(claim.id, "Payment binding or provider state is not ready.");
      return { statusCode: 202, body: { status: "pending" }, delivery: accepted };
    } catch {
      const markFailed =
        this.inbox.markFailed?.bind(this.inbox) ?? this.inbox.markPending.bind(this.inbox);
      await markFailed(claim.id, "Provider state could not be reconciled.");
      return {
        statusCode: 503,
        body: { error: "Webhook processing is temporarily unavailable." },
        delivery: accepted,
      };
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

  /** API hosts accepted when extracting IDs from resource links. */
  private linkHosts(): readonly string[] {
    return this.paypal.hosts?.resourceLinkHosts ?? PAYPAL_ENVIRONMENTS.sandbox.resourceLinkHosts;
  }

  private async authoritative(
    eventType: string,
    resource: Record<string, unknown>,
  ): Promise<AuthoritativeWebhookData | null> {
    const hosts = this.linkHosts();
    if (
      eventType === "VAULT.PAYMENT-TOKEN.CREATED" ||
      eventType === "VAULT.PAYMENT-TOKEN.DELETED"
    ) {
      const tokenId = VaultIdSchema.safeParse(resource.id);
      if (!tokenId.success) return null;
      let token: PayPalVaultPaymentToken | null;
      try {
        token = await this.paypal.getVaultPaymentToken(tokenId.data);
      } catch (error) {
        // Only PayPal's own 404 proves the token is gone; anything else is retried.
        if (!(error instanceof PayPalProviderError && error.status === 404)) throw error;
        token = null;
      }
      return { kind: "payment_token", eventType, tokenId: tokenId.data, token };
    }

    if (eventType === "CHECKOUT.ORDER.APPROVED" || eventType === "CHECKOUT.ORDER.COMPLETED") {
      const orderId = stringAt(resource, "id");
      if (!orderId) return null;
      return { kind: "order", order: await this.paypal.getOrder(orderId) };
    }

    if (
      eventType === "PAYMENT.CAPTURE.COMPLETED" ||
      eventType === "PAYMENT.CAPTURE.DENIED" ||
      eventType === "PAYMENT.CAPTURE.PENDING"
    ) {
      const captureId = stringAt(resource, "id");
      if (!captureId) return null;
      const capture = await this.paypal.getCapture(captureId);
      const orderId = relatedOrderId(capture, hosts) ?? relatedOrderId(resource, hosts);
      return {
        kind: "capture",
        capture,
        order: orderId ? await this.paypal.getOrder(orderId) : null,
      };
    }

    if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      const refundId = stringAt(resource, "id");
      if (!refundId) return null;
      const refund = await this.paypal.getRefund(refundId);
      const captureId = relatedCaptureId(refund, hosts) ?? relatedCaptureId(resource, hosts);
      const capture = captureId ? await this.paypal.getCapture(captureId) : null;
      const orderId =
        (capture ? relatedOrderId(capture, hosts) : null) ?? relatedOrderId(resource, hosts);
      return {
        kind: "refund",
        refund,
        capture,
        order: orderId ? await this.paypal.getOrder(orderId) : null,
      };
    }

    if (eventType === "PAYMENT.CAPTURE.REVERSED") {
      // A reversal resource is either a refund-like object linked to the
      // original capture or the capture itself. Both are re-fetched from PayPal.
      const resourceId = stringAt(resource, "id");
      if (!resourceId) return null;
      const linkedCapture = relatedCaptureId(resource, hosts);
      let refund: PayPalRefund | null = null;
      let captureId = resourceId;
      if (linkedCapture && linkedCapture !== resourceId) {
        refund = await this.paypal.getRefund(resourceId);
        captureId = relatedCaptureId(refund, hosts) ?? linkedCapture;
      }
      const capture = await this.paypal.getCapture(captureId);
      const orderId = relatedOrderId(capture, hosts) ?? relatedOrderId(resource, hosts);
      return {
        kind: "reversal",
        capture,
        refund,
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
