import { describe, expect, it, vi } from "vitest";
import {
  PayPalWebhookService,
  PayPalProviderError,
  registerPayPalWebhookRoute,
  type PayPalWebhookReconciler,
  type WebhookInboxStore,
} from "../src/index.js";
import type { PayPalClient } from "../src/client.js";

const headers = {
  "paypal-transmission-id": "transmission-1",
  "paypal-transmission-time": "2026-10-02T12:00:00Z",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "signature",
};

const captureEvent = (eventType = "PAYMENT.CAPTURE.COMPLETED") =>
  JSON.stringify({
    id: "WH-EVENT-1",
    event_type: eventType,
    resource: {
      id: "CAPTURE-123",
      supplementary_data: { related_ids: { order_id: "ORDER-123", capture_id: "CAPTURE-123" } },
    },
  });

function fakePayPal(verified = true) {
  return {
    verifyWebhook: vi.fn().mockResolvedValue(verified),
    getOrder: vi.fn().mockResolvedValue({
      id: "ORDER-123",
      status: "COMPLETED",
      links: [],
      approvalUrl: null,
    }),
    getCapture: vi.fn().mockResolvedValue({
      id: "CAPTURE-123",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "12.34" },
      custom_id: "proposal-123",
    }),
    getRefund: vi.fn().mockResolvedValue({
      id: "REFUND-123",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "5.00" },
    }),
  } as unknown as PayPalClient;
}

function fakeInbox(overrides: Partial<WebhookInboxStore> = {}) {
  return {
    claim: vi.fn().mockResolvedValue({ id: "inbox-1", shouldProcess: true, status: "RECEIVED" }),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markIgnored: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as WebhookInboxStore & {
    claim: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
    markPending: ReturnType<typeof vi.fn>;
    markIgnored: ReturnType<typeof vi.fn>;
  };
}

function fakeReconciler(outcome: "processed" | "pending" | "ignored" = "processed") {
  return {
    reconcile: vi.fn().mockResolvedValue(outcome),
  } as PayPalWebhookReconciler & { reconcile: ReturnType<typeof vi.fn> };
}

function service(
  paypal: PayPalClient = fakePayPal(),
  inbox = fakeInbox(),
  reconciler = fakeReconciler(),
) {
  return {
    service: new PayPalWebhookService(paypal, inbox, reconciler),
    paypal,
    inbox,
    reconciler,
  };
}

describe("PayPal webhook service", () => {
  it("rejects missing signatures before any inbox write", async () => {
    const context = service();
    const result = await context.service.handle({ rawBody: captureEvent(), headers: {} });

    expect(result.statusCode).toBe(400);
    expect(context.paypal.verifyWebhook).not.toHaveBeenCalled();
    expect(context.inbox.claim).not.toHaveBeenCalled();
  });

  it("returns unauthorized when provider says the signature is invalid", async () => {
    const context = service(fakePayPal(false));
    const result = await context.service.handle({ rawBody: captureEvent(), headers });

    expect(result.statusCode).toBe(401);
    expect(context.inbox.claim).not.toHaveBeenCalled();
  });

  it("returns retryable failure when the verification provider is unavailable", async () => {
    const paypal = fakePayPal();
    (paypal.verifyWebhook as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PayPalProviderError("UPSTREAM_UNAVAILABLE", 503, { retryable: true }),
    );
    const context = service(paypal);
    const result = await context.service.handle({ rawBody: captureEvent(), headers });

    expect(result.statusCode).toBe(503);
    expect(context.inbox.claim).not.toHaveBeenCalled();
  });

  it("requires raw body size bounds and strict event identity/resource fields", async () => {
    const context = service();
    const oversized = await context.service.handle({
      rawBody: "x".repeat(1_000_001),
      headers,
    });
    expect(oversized.statusCode).toBe(413);
    expect(context.paypal.verifyWebhook).not.toHaveBeenCalled();

    const invalid = await context.service.handle({ rawBody: JSON.stringify({ id: "x" }), headers });
    expect(invalid.statusCode).toBe(400);
    expect(context.inbox.claim).not.toHaveBeenCalled();
  });

  it("verifies before claiming, fetches authoritative capture/order state, and processes once", async () => {
    const context = service();
    const result = await context.service.handle({ rawBody: captureEvent(), headers });

    expect(result).toEqual({ statusCode: 200, body: { status: "processed" } });
    expect(context.paypal.verifyWebhook).toHaveBeenCalledWith({
      rawBody: captureEvent(),
      headers: expect.any(Object),
    });
    expect(context.paypal.getCapture).toHaveBeenCalledWith("CAPTURE-123");
    expect(context.paypal.getOrder).toHaveBeenCalledWith("ORDER-123");
    expect(context.inbox.claim).toHaveBeenCalledTimes(1);
    expect(context.reconciler.reconcile).toHaveBeenCalledWith({
      event: expect.objectContaining({ id: "WH-EVENT-1" }),
      authoritative: expect.objectContaining({ kind: "capture" }),
    });
    expect(context.inbox.markProcessed).toHaveBeenCalledWith("inbox-1");
  });

  it("deduplicates already processed events without provider lookups or duplicate writes", async () => {
    const inbox = fakeInbox({
      claim: vi
        .fn()
        .mockResolvedValue({ id: "inbox-1", shouldProcess: false, status: "PROCESSED" }),
    });
    const context = service(fakePayPal(), inbox);
    const result = await context.service.handle({ rawBody: captureEvent(), headers });

    expect(result).toEqual({ statusCode: 200, body: { status: "duplicate" } });
    expect(context.paypal.getCapture).not.toHaveBeenCalled();
    expect(context.inbox.markProcessed).not.toHaveBeenCalled();
  });

  it("keeps pending and unknown ownership safe without manufacturing payment state", async () => {
    const pending = service(fakePayPal(), fakeInbox(), fakeReconciler("pending"));
    const pendingResult = await pending.service.handle({ rawBody: captureEvent(), headers });
    expect(pendingResult.statusCode).toBe(202);
    expect(pending.inbox.markPending).toHaveBeenCalled();

    const ignored = service(fakePayPal(), fakeInbox(), fakeReconciler("ignored"));
    const ignoredResult = await ignored.service.handle({ rawBody: captureEvent(), headers });
    expect(ignoredResult.statusCode).toBe(200);
    expect(ignored.inbox.markIgnored).toHaveBeenCalled();
  });

  it.each(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"])(
    "routes supported event type %s through authoritative provider lookups",
    async (eventType) => {
      const context = service();
      const result = await context.service.handle({ rawBody: captureEvent(eventType), headers });

      expect(result.statusCode).toBe(200);
      if (eventType === "CHECKOUT.ORDER.APPROVED") {
        expect(context.paypal.getOrder).toHaveBeenCalledWith("CAPTURE-123");
      }
      if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
        expect(context.paypal.getRefund).toHaveBeenCalledWith("CAPTURE-123");
        expect(context.paypal.getCapture).toHaveBeenCalledWith("CAPTURE-123");
      }
    },
  );

  it("ignores unsupported events after durable claim without provider writes", async () => {
    const context = service();
    const event = JSON.stringify({ id: "WH-UNKNOWN", event_type: "SOME.NEW.EVENT", resource: {} });
    const result = await context.service.handle({ rawBody: event, headers });

    expect(result).toEqual({ statusCode: 200, body: { status: "ignored" } });
    expect(context.inbox.markIgnored).toHaveBeenCalledWith("inbox-1", expect.any(String));
    expect(context.paypal.getOrder).not.toHaveBeenCalled();
    expect(context.paypal.getCapture).not.toHaveBeenCalled();
  });

  it("registers the exact public webhook route and passes raw body through", async () => {
    let registeredPath = "";
    let registeredHandler: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const app = {
      post(path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) {
        registeredPath = path;
        registeredHandler = handler;
      },
    };
    const context = service();
    registerPayPalWebhookRoute(app, context.service);
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    await registeredHandler!({ rawBody: captureEvent(), headers }, reply);
    expect(registeredPath).toBe("/api/webhooks/paypal");
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
