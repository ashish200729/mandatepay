import { describe, expect, it } from "vitest";
import {
  PayPalClient,
  PayPalInputError,
  PayPalResponseError,
  PayPalWebhookError,
  loadPayPalConfig,
  parsePayPalConfig,
  parseProviderMoney,
  type PayPalConfig,
} from "../src/index.js";

const sandboxConfig = (overrides: Partial<PayPalConfig> = {}): PayPalConfig =>
  parsePayPalConfig({
    environment: "sandbox",
    clientId: "client-test-secret",
    clientSecret: "secret-test-value",
    webhookId: "webhook-test-id",
    timeoutMs: 1_000,
    maxRetries: 0,
    ...overrides,
  });

const tokenResponse = (expiresIn = 3_600) => ({
  access_token: "access-token-test",
  token_type: "Bearer",
  expires_in: expiresIn,
});

const orderResponse = (approvalHost = "www.sandbox.paypal.com") => ({
  id: "ORDER-123",
  status: "CREATED",
  links: [
    { href: `https://${approvalHost}/checkoutnow?token=ORDER-123`, rel: "approve", method: "GET" },
    {
      href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-123",
      rel: "self",
      method: "GET",
    },
  ],
});

const captureResponse = (currency = "USD") => ({
  id: "CAPTURE-123",
  status: "COMPLETED",
  amount: { currency_code: currency, value: "12.34" },
  custom_id: "proposal-123",
});

const orderCaptureResponse = (currency = "USD") => ({
  id: "ORDER-123",
  status: "COMPLETED",
  links: [],
  purchase_units: [{ payments: { captures: [captureResponse(currency)] } }],
});

const refundResponse = {
  id: "REFUND-123",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "5.00" },
  invoice_id: "refund-local",
  create_time: "2026-10-03T23:00:06-07:00",
};

function queueFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
    callIndex: number,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { fetcher, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: { init: RequestInit | undefined }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe("PayPal Sandbox client", () => {
  it("reports sandbox reachability without returning the access token or client secret", async () => {
    const { fetcher } = queueFetch(() =>
      jsonResponse({
        access_token: "super-secret-probe-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: fetcher });
    const probe = await client.probeSandbox();
    expect(probe.status).toBe("ready");
    expect(probe.code).toBe("PAYPAL_REACHABLE");
    expect(JSON.stringify(probe)).not.toContain("super-secret-probe-token");
    expect(JSON.stringify(probe)).not.toContain("secret-test-value");
    expect(JSON.stringify(probe)).not.toContain("client-test-secret");
  });

  it("rejects live environments and arbitrary base URL fields", () => {
    expect(() =>
      parsePayPalConfig({ environment: "live", clientId: "id", clientSecret: "secret" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT" }));
    expect(() =>
      parsePayPalConfig({
        environment: "sandbox",
        clientId: "id",
        clientSecret: "secret",
        baseURL: "https://attacker.example",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT" }));
  });

  it("treats a blank webhook ID as absent", () => {
    const config = loadPayPalConfig({
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: "   ",
    });
    expect(config.webhookId).toBeNull();
  });

  it("coalesces concurrent OAuth requests and caches the token", async () => {
    let tokenCalls = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse(tokenResponse());
      }
      return jsonResponse({ ...orderResponse(), status: "COMPLETED" });
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    const tokens = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(tokenCalls).toBe(1);
    await client.getAccessToken();
    expect(tokenCalls).toBe(1);
  });

  it("refreshes an expired token instead of reusing it", async () => {
    let tokenCalls = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse(tokenResponse(1));
      }
      return jsonResponse(orderResponse());
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    await client.getAccessToken();
    await client.getAccessToken();
    expect(tokenCalls).toBe(2);
  });

  it("creates an idempotent CAPTURE order with server-computed USD cents", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse(orderResponse()),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    const order = await client.createOrder({
      amountMinor: 1_234,
      referenceId: "proposal-123",
      customId: "proposal-123",
      requestId: "proposal-123-create",
      returnUrl: "https://app.example.test/paypal/return",
      cancelUrl: "https://app.example.test/paypal/cancel",
    });

    const orderCall = transport.calls[1]!;
    expect(orderCall.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(new Headers(orderCall.init?.headers).get("PayPal-Request-Id")).toBe(
      "proposal-123-create",
    );
    expect(new Headers(orderCall.init?.headers).get("Prefer")).toBe("return=representation");
    expect(bodyOf(orderCall)).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "proposal-123",
          custom_id: "proposal-123",
          amount: { currency_code: "USD", value: "12.34" },
        },
      ],
    });
    expect(order.id).toBe("ORDER-123");
    expect(order.approvalUrl).toContain("sandbox.paypal.com");
  });

  it("rejects a non-Sandbox approval URL before browser use", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse(orderResponse("evil.example")),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    await expect(
      client.createOrder({
        amountMinor: 100,
        referenceId: "proposal-123",
        customId: "proposal-123",
        requestId: "proposal-123-create",
        returnUrl: "https://app.example.test/return",
        cancelUrl: "https://app.example.test/cancel",
      }),
    ).rejects.toBeInstanceOf(PayPalResponseError);

    const embeddedCredentials = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse(orderResponse("user@www.sandbox.paypal.com")),
    );
    const embeddedClient = new PayPalClient(sandboxConfig(), {
      fetch: embeddedCredentials.fetcher,
    });
    await expect(
      embeddedClient.createOrder({
        amountMinor: 100,
        referenceId: "proposal-embedded",
        customId: "proposal-embedded",
        requestId: "proposal-embedded",
        returnUrl: "http://localhost:3000/return",
        cancelUrl: "http://127.0.0.1:3000/cancel",
      }),
    ).rejects.toBeInstanceOf(PayPalResponseError);
  });

  it("allows loopback HTTP redirects in Sandbox but rejects public HTTP", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse(orderResponse()),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await expect(
      client.createOrder({
        amountMinor: 100,
        referenceId: "proposal-local",
        customId: "proposal-local",
        requestId: "proposal-local",
        returnUrl: "http://localhost:3000/return",
        cancelUrl: "http://127.0.0.1:3000/cancel",
      }),
    ).resolves.toMatchObject({ id: "ORDER-123" });

    await expect(
      client.createOrder({
        amountMinor: 100,
        referenceId: "proposal-public-http",
        customId: "proposal-public-http",
        requestId: "proposal-public-http",
        returnUrl: "http://example.test/return",
        cancelUrl: "https://app.example.test/cancel",
      }),
    ).rejects.toBeInstanceOf(PayPalInputError);
  });

  it("captures orders and validates the nested capture response", async () => {
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return jsonResponse(orderCaptureResponse());
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    const capture = await client.captureOrder("ORDER-123", "proposal-123-capture");
    const call = transport.calls[1]!;
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-123/capture");
    expect(new Headers(call.init?.headers).get("PayPal-Request-Id")).toBe("proposal-123-capture");
    expect(new Headers(call.init?.headers).get("Prefer")).toBe("return=representation");
    expect(capture.id).toBe("CAPTURE-123");
    expect(capture.amount.currency_code).toBe("USD");
    expect(capture.custom_id).toBe("proposal-123");
  });

  it("rejects multi-unit or multi-capture responses instead of selecting one", async () => {
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return jsonResponse({
        ...orderCaptureResponse(),
        purchase_units: [
          { payments: { captures: [captureResponse()] } },
          { payments: { captures: [captureResponse()] } },
        ],
      });
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await expect(client.captureOrder("ORDER-123", "capture-multiple")).rejects.toBeInstanceOf(
      PayPalResponseError,
    );

    const multipleCaptures = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return jsonResponse({
        ...orderCaptureResponse(),
        purchase_units: [{ payments: { captures: [captureResponse(), captureResponse()] } }],
      });
    });
    const multipleClient = new PayPalClient(sandboxConfig(), { fetch: multipleCaptures.fetcher });
    await expect(
      multipleClient.captureOrder("ORDER-123", "capture-multiple-2"),
    ).rejects.toBeInstanceOf(PayPalResponseError);
  });

  it("supports full and explicit partial refunds with stable request IDs", async () => {
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return jsonResponse(refundResponse);
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    await client.refundCapture({
      captureId: "CAPTURE-123",
      requestId: "refund-full",
      amountMinor: null,
    });
    await client.refundCapture({
      captureId: "CAPTURE-123",
      requestId: "refund-partial",
      amountMinor: 500,
      invoiceId: "refund-local",
      reason: "Damaged item",
    });
    expect(bodyOf(transport.calls[1]!)).toEqual({});
    expect(bodyOf(transport.calls[2]!)).toEqual({
      amount: { currency_code: "USD", value: "5.00" },
      invoice_id: "refund-local",
      note_to_payer: "Damaged item",
    });
    expect(new Headers(transport.calls[2]!.init?.headers).get("PayPal-Request-Id")).toBe(
      "refund-partial",
    );
  });

  it.each(["x".repeat(39), "非ASCII", "invalid\nheader"])(
    "rejects unsupported idempotency key %s before network access",
    async (requestId) => {
      const transport = queueFetch(() => jsonResponse(tokenResponse()));
      const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
      await expect(client.captureOrder("ORDER-123", requestId)).rejects.toBeInstanceOf(
        PayPalInputError,
      );
      expect(transport.calls).toHaveLength(0);
    },
  );

  it("clears a rejected cached token without automatically repeating a financial call", async () => {
    let tokens = 0;
    let resources = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) {
        tokens++;
        return jsonResponse(tokenResponse());
      }
      if (++resources === 1) return jsonResponse({}, 401);
      return jsonResponse(orderResponse());
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await expect(client.getOrder("ORDER-123")).rejects.toMatchObject({ status: 401 });
    expect(resources).toBe(1);
    expect(await client.getOrder("ORDER-123")).toMatchObject({ id: "ORDER-123" });
    expect(tokens).toBe(2);
  });

  it("hydrates a minimal refund with a read without repeating the refund mutation", async () => {
    const transport = queueFetch((url, init) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return init?.method === "POST"
        ? jsonResponse({ id: "REFUND-123", status: "COMPLETED" })
        : jsonResponse(refundResponse);
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    expect(
      await client.refundCapture({
        captureId: "CAPTURE-123",
        requestId: "stable-refund",
        amountMinor: 500,
      }),
    ).toMatchObject(refundResponse);
    expect(
      transport.calls.filter(
        (call) => call.url.endsWith("/refund") && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(transport.calls.at(-1)?.url).toContain("/v2/payments/refunds/REFUND-123");
  });

  it("validates capture currency and does not treat malformed responses as completed", async () => {
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return jsonResponse(orderCaptureResponse("EUR"));
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await expect(client.captureOrder("ORDER-123", "capture-key")).rejects.toBeInstanceOf(
      PayPalResponseError,
    );
    expect(() => parseProviderMoney({ currency_code: "USD", value: "1e2" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ORDER_RESPONSE" }),
    );
    expect(() =>
      parseProviderMoney({ currency_code: "USD", value: "999999999999999999999999.99" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORDER_RESPONSE" }));
  });

  it("marks mutation timeouts as unknown outcomes for reconciliation", async () => {
    const transport = queueFetch(async (url, init) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return jsonResponse(orderResponse());
    });
    const client = new PayPalClient(sandboxConfig({ timeoutMs: 5 }), { fetch: transport.fetcher });

    await expect(client.captureOrder("ORDER-123", "capture-timeout")).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      unknownOutcome: true,
    });
  });

  it("requires all webhook headers and never verifies unsigned events locally", async () => {
    let calls = 0;
    const transport = queueFetch((url) => {
      calls += 1;
      return url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({ verification_status: "SUCCESS" });
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });

    await expect(client.verifyWebhook({ rawBody: "{}", headers: {} })).rejects.toBeInstanceOf(
      PayPalWebhookError,
    );
    expect(calls).toBe(0);
  });

  it("posts raw-event verification fields and returns PayPal's verification status", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({ verification_status: "SUCCESS" }),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    const verified = await client.verifyWebhook({
      rawBody: '{"id":"WH-123","event_type":"PAYMENT.CAPTURE.COMPLETED"}',
      headers: {
        transmissionId: "transmission-1",
        transmissionTime: "2026-10-02T12:00:00Z",
        certUrl: "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        authAlgo: "SHA256withRSA",
        transmissionSig: "signature",
      },
    });

    expect(verified).toBe(true);
    const call = transport.calls[1]!;
    expect(call.url).toBe(
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
    );
    expect(bodyOf(call)).toMatchObject({
      transmission_id: "transmission-1",
      webhook_id: "webhook-test-id",
      webhook_event: { id: "WH-123" },
    });
  });

  it("returns false for a verified PayPal signature failure", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({ verification_status: "FAILURE" }),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    const result = await client.verifyWebhook({
      rawBody: '{"id":"WH-123"}',
      headers: {
        transmissionId: "transmission-1",
        transmissionTime: "2026-10-02T12:00:00Z",
        certUrl: "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        authAlgo: "SHA256withRSA",
        transmissionSig: "signature",
      },
    });
    expect(result).toBe(false);
  });
});
