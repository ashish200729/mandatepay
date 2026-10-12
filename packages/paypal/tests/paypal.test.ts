import { describe, expect, it } from "vitest";
import {
  PayPalClient,
  PayPalInputError,
  PayPalResponseError,
  PayPalProviderError,
  PayPalWebhookError,
  classifyPayPalError,
  isDefinitivePayPalRejection,
  loadPayPalConfig,
  parsePayPalErrorBody,
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

  it("accepts only sandbox or explicit live environments and rejects base URL fields", () => {
    expect(() =>
      parsePayPalConfig({ environment: "production", clientId: "id", clientSecret: "secret" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT" }));
    expect(parsePayPalConfig({ clientId: "id", clientSecret: "secret" }).environment).toBe(
      "sandbox",
    );
    expect(
      parsePayPalConfig({ environment: "live", clientId: "id", clientSecret: "secret" })
        .environment,
    ).toBe("live");
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

  it("refreshes a rejected token and repeats the same request exactly once", async () => {
    let tokens = 0;
    let resources = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) {
        tokens++;
        return jsonResponse(tokenResponse());
      }
      if (++resources === 1) return jsonResponse({}, 401);
      return jsonResponse(orderCaptureResponse());
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    expect(await client.captureOrder("ORDER-123", "capture-after-401")).toMatchObject({
      id: "CAPTURE-123",
    });
    expect(resources).toBe(2);
    expect(tokens).toBe(2);
    const captureCalls = transport.calls.filter((call) => call.url.endsWith("/capture"));
    expect(
      captureCalls.map((call) => new Headers(call.init?.headers).get("PayPal-Request-Id")),
    ).toEqual(["capture-after-401", "capture-after-401"]);
  });

  it("stops after one token refresh when PayPal keeps rejecting authentication", async () => {
    let resources = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      resources += 1;
      return jsonResponse({ name: "AUTHENTICATION_FAILURE" }, 401);
    });
    const client = new PayPalClient(sandboxConfig({ maxRetries: 2 }), {
      fetch: transport.fetcher,
      sleep: async () => undefined,
    });
    const error = await client.getOrder("ORDER-123").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED", status: 401 });
    expect(classifyPayPalError(error)).toBe("uncertain");
    expect(resources).toBe(2);
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

const webhookHeaders = {
  transmissionId: "transmission-1",
  transmissionTime: "2026-10-02T12:00:00Z",
  certUrl: "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  authAlgo: "SHA256withRSA",
  transmissionSig: "signature",
};

const orderInput = (overrides: Record<string, unknown> = {}) => ({
  amountMinor: 1_534,
  referenceId: "payment-123",
  customId: "proposal-123",
  requestId: "order-request-1",
  returnUrl: "https://app.example.test/orders/payment-123?paypal=return",
  cancelUrl: "https://app.example.test/orders/payment-123?paypal=cancel",
  ...overrides,
});

describe("PayPal provider error classification", () => {
  it("keeps only the name, first issue and debug id from a PayPal error body", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse(
            {
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed for buyer@example.test",
              debug_id: "f1a2b3c4d5e6",
              details: [
                { issue: "INSTRUMENT_DECLINED", description: "Card 4111 declined for buyer" },
                { issue: "SECOND_ISSUE" },
              ],
              links: [
                { href: "https://www.sandbox.paypal.com/checkoutnow?token=X", rel: "redirect" },
              ],
            },
            422,
          ),
    );
    const client = new PayPalClient(sandboxConfig({ maxRetries: 2 }), {
      fetch: transport.fetcher,
      sleep: async () => undefined,
    });
    const error = await client
      .captureOrder("ORDER-123", "capture-declined")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PayPalProviderError);
    expect(error).toMatchObject({
      code: "UPSTREAM_REQUEST_FAILED",
      status: 422,
      providerName: "UNPROCESSABLE_ENTITY",
      issue: "INSTRUMENT_DECLINED",
      debugId: "f1a2b3c4d5e6",
      unknownOutcome: false,
    });
    expect(isDefinitivePayPalRejection(error)).toBe(true);
    const serialized = JSON.stringify({ ...(error as object), message: String(error) });
    expect(serialized).not.toContain("buyer");
    expect(serialized).not.toContain("4111");
    // A definitive rejection is never retried.
    expect(transport.calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
  });

  it.each([
    [400, "definitive"],
    [403, "definitive"],
    [404, "definitive"],
    [422, "definitive"],
    [401, "uncertain"],
    [408, "uncertain"],
    [409, "uncertain"],
    [429, "uncertain"],
    [500, "uncertain"],
    [503, "uncertain"],
  ] as const)("classifies a PayPal HTTP %i response as %s", async (status, expected) => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({ name: "SOME_ERROR" }, status),
    );
    const client = new PayPalClient(sandboxConfig({ maxRetries: 0 }), {
      fetch: transport.fetcher,
    });
    const error = await client.getCapture("CAPTURE-123").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PayPalProviderError);
    expect(classifyPayPalError(error)).toBe(expected);
  });

  it("treats network failures, timeouts, malformed bodies and unknown errors as uncertain", () => {
    expect(classifyPayPalError(new PayPalProviderError("UPSTREAM_TIMEOUT"))).toBe("uncertain");
    expect(classifyPayPalError(new PayPalProviderError("UPSTREAM_REQUEST_FAILED"))).toBe(
      "uncertain",
    );
    expect(classifyPayPalError(new PayPalProviderError("MALFORMED_RESPONSE"))).toBe("uncertain");
    expect(classifyPayPalError(new Error("socket hang up"))).toBe("uncertain");
    expect(parsePayPalErrorBody("<html>bad gateway</html>")).toBeNull();
    expect(parsePayPalErrorBody('{"name":"lower case","debug_id":"<script>"}')).toBeNull();
    expect(parsePayPalErrorBody('{"error":"invalid_client"}')).toEqual({
      name: "INVALID_CLIENT",
      issue: null,
      debugId: null,
    });
  });
});

describe("PayPal bounded retries", () => {
  it("retries idempotent reads after uncertain failures with exponential backoff", async () => {
    let reads = 0;
    const delays: number[] = [];
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      reads += 1;
      return reads < 3
        ? jsonResponse({ name: "INTERNAL_SERVER_ERROR" }, 503)
        : jsonResponse(orderResponse());
    });
    const client = new PayPalClient(sandboxConfig({ maxRetries: 2 }), {
      fetch: transport.fetcher,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(await client.getOrder("ORDER-123")).toMatchObject({ id: "ORDER-123" });
    expect(reads).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("replays a capture with the same PayPal-Request-Id and stops at maxRetries", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse({}, 502),
    );
    const client = new PayPalClient(sandboxConfig({ maxRetries: 2 }), {
      fetch: transport.fetcher,
      sleep: async () => undefined,
    });
    await expect(client.captureOrder("ORDER-123", "capture-stable")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 502,
      unknownOutcome: true,
    });
    const captures = transport.calls.filter((call) => call.url.endsWith("/capture"));
    expect(captures).toHaveLength(3);
    expect(
      new Set(captures.map((call) => new Headers(call.init?.headers).get("PayPal-Request-Id"))),
    ).toEqual(new Set(["capture-stable"]));
  });

  it("retries network failures for keyed mutations but never for unkeyed POSTs", async () => {
    let refunds = 0;
    let verifications = 0;
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      if (url.endsWith("/refund")) {
        refunds += 1;
        if (refunds === 1) throw new TypeError("fetch failed");
        return jsonResponse(refundResponse);
      }
      verifications += 1;
      return jsonResponse({}, 503);
    });
    const client = new PayPalClient(sandboxConfig({ maxRetries: 2 }), {
      fetch: transport.fetcher,
      sleep: async () => undefined,
    });
    await expect(
      client.refundCapture({ captureId: "CAPTURE-123", requestId: "refund-net", amountMinor: 500 }),
    ).resolves.toMatchObject({ id: "REFUND-123" });
    expect(refunds).toBe(2);
    await expect(
      client.verifyWebhook({ rawBody: '{"id":"WH-1"}', headers: webhookHeaders }),
    ).rejects.toMatchObject({ status: 503 });
    expect(verifications).toBe(1);
  });
});

describe("PayPal order payload and environments", () => {
  it("uses payment_source experience_context, line items and an exact breakdown", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse(orderResponse()),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await client.createOrder(
      orderInput({
        items: [{ name: "Demo headphones", sku: "sku-1", quantity: 1, unitAmountMinor: 1_234 }],
        shippingMinor: 200,
        taxMinor: 100,
      }),
    );
    const body = bodyOf(transport.calls[1]!);
    expect(body).not.toHaveProperty("application_context");
    expect(body.payment_source).toEqual({
      paypal: {
        experience_context: {
          brand_name: "MandatePay",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: "https://app.example.test/orders/payment-123?paypal=return",
          cancel_url: "https://app.example.test/orders/payment-123?paypal=cancel",
        },
      },
    });
    expect(body.purchase_units).toEqual([
      {
        reference_id: "payment-123",
        custom_id: "proposal-123",
        amount: {
          currency_code: "USD",
          value: "15.34",
          breakdown: {
            item_total: { currency_code: "USD", value: "12.34" },
            shipping: { currency_code: "USD", value: "2.00" },
            tax_total: { currency_code: "USD", value: "1.00" },
          },
        },
        items: [
          {
            name: "Demo headphones",
            sku: "sku-1",
            quantity: "1",
            unit_amount: { currency_code: "USD", value: "12.34" },
          },
        ],
      },
    ]);
  });

  it("accepts PayPal's representation echoing line items and the amount breakdown", async () => {
    const echoed = {
      ...orderResponse(),
      purchase_units: [
        {
          reference_id: "payment-123",
          custom_id: "proposal-123",
          amount: {
            currency_code: "USD",
            value: "15.34",
            breakdown: {
              item_total: { currency_code: "USD", value: "12.34" },
              shipping: { currency_code: "USD", value: "2.00" },
              tax_total: { currency_code: "USD", value: "1.00" },
            },
          },
          items: [
            {
              name: "Demo headphones",
              quantity: "1",
              unit_amount: { currency_code: "USD", value: "12.34" },
            },
          ],
        },
      ],
    };
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse(echoed),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    const order = await client.createOrder(
      orderInput({
        items: [{ name: "Demo headphones", quantity: 1, unitAmountMinor: 1_234 }],
        shippingMinor: 200,
        taxMinor: 100,
      }),
    );
    expect(order.approvalUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123");
    expect(parseProviderMoney(order.purchase_units?.[0]?.amount)).toBe(1_534);
    expect(() =>
      parseProviderMoney({
        currency_code: "USD",
        value: "15.34",
        breakdown: { item_total: { currency_code: "EUR", value: "12.34" } },
      }),
    ).toThrow(PayPalResponseError);
  });

  it("rejects an inconsistent breakdown before any network access", async () => {
    const transport = queueFetch(() => jsonResponse(tokenResponse()));
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await expect(
      client.createOrder(
        orderInput({ items: [{ name: "Item", quantity: 2, unitAmountMinor: 500 }], taxMinor: 1 }),
      ),
    ).rejects.toBeInstanceOf(PayPalInputError);
    expect(transport.calls).toHaveLength(0);
  });

  it("extracts a payer-action link when payment_source returns PAYER_ACTION_REQUIRED", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({
            id: "ORDER-123",
            status: "PAYER_ACTION_REQUIRED",
            links: [
              {
                href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
                rel: "payer-action",
                method: "GET",
              },
            ],
          }),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    const order = await client.createOrder(orderInput());
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    expect(order.approvalUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123");
  });

  it("maps PAYPAL_ENV=live to production hosts only", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse(orderResponse("www.paypal.com")),
    );
    const client = new PayPalClient(sandboxConfig({ environment: "live" }), {
      fetch: transport.fetcher,
    });
    const order = await client.createOrder(orderInput());
    expect(transport.calls.map((call) => new URL(call.url).origin)).toEqual([
      "https://api-m.paypal.com",
      "https://api-m.paypal.com",
    ]);
    expect(order.approvalUrl).toBe("https://www.paypal.com/checkoutnow?token=ORDER-123");
    expect(client.checkoutUrl("ORDER-123")).toBe(
      "https://www.paypal.com/checkoutnow?token=ORDER-123",
    );

    const sandboxHost = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse(orderResponse("www.sandbox.paypal.com")),
    );
    const liveClient = new PayPalClient(sandboxConfig({ environment: "live" }), {
      fetch: sandboxHost.fetcher,
    });
    await expect(liveClient.createOrder(orderInput())).rejects.toBeInstanceOf(PayPalResponseError);
    await expect(
      liveClient.createOrder(orderInput({ returnUrl: "http://localhost:3000/return" })),
    ).rejects.toBeInstanceOf(PayPalInputError);
    expect(
      new PayPalClient(sandboxConfig(), { fetch: sandboxHost.fetcher }).checkoutUrl("O-1"),
    ).toBe("https://www.sandbox.paypal.com/checkoutnow?token=O-1");
  });

  it("keeps invoice_id and note_to_payer on full refunds", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token") ? jsonResponse(tokenResponse()) : jsonResponse(refundResponse),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    await client.refundCapture({
      captureId: "CAPTURE-123",
      requestId: "refund-full-note",
      amountMinor: null,
      invoiceId: "refund-local",
      reason: "Changed my mind",
    });
    expect(bodyOf(transport.calls[1]!)).toEqual({
      invoice_id: "refund-local",
      note_to_payer: "Changed my mind",
    });
  });

  it("parses FAILED captures and keeps a pending capture's status reason", async () => {
    const transport = queueFetch((url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse(tokenResponse());
      return url.includes("CAPTURE-FAILED")
        ? jsonResponse({ ...captureResponse(), id: "CAPTURE-FAILED", status: "FAILED" })
        : jsonResponse({
            ...captureResponse(),
            status: "PENDING",
            status_details: { reason: "PENDING_REVIEW" },
          });
    });
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    expect((await client.getCapture("CAPTURE-FAILED")).status).toBe("FAILED");
    expect((await client.getCapture("CAPTURE-123")).status_details?.reason).toBe("PENDING_REVIEW");
  });
});

describe("PayPal webhook signature verification", () => {
  it("embeds the raw delivered body byte-for-byte instead of re-serializing it", async () => {
    const transport = queueFetch((url) =>
      url.endsWith("/oauth2/token")
        ? jsonResponse(tokenResponse())
        : jsonResponse({ verification_status: "SUCCESS" }),
    );
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    const rawBody =
      '{ "id" : "WH-RAW",\n "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"value":1.10,"name":"caf\\u00e9","id":"C-1"}}';
    expect(await client.verifyWebhook({ rawBody, headers: webhookHeaders })).toBe(true);
    const sent = String(transport.calls[1]!.init?.body);
    expect(sent.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);
    expect(JSON.parse(sent)).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: webhookHeaders.certUrl,
      transmission_id: "transmission-1",
      transmission_sig: "signature",
      transmission_time: "2026-10-02T12:00:00Z",
      webhook_id: "webhook-test-id",
      webhook_event: { id: "WH-RAW" },
    });
  });

  it("rejects non-object raw bodies before calling PayPal", async () => {
    const transport = queueFetch(() => jsonResponse(tokenResponse()));
    const client = new PayPalClient(sandboxConfig(), { fetch: transport.fetcher });
    for (const rawBody of ['["array"]', '"text"', '{"id":1} trailing', "null"]) {
      await expect(
        client.verifyWebhook({ rawBody, headers: webhookHeaders }),
      ).rejects.toBeInstanceOf(PayPalWebhookError);
    }
    expect(transport.calls).toHaveLength(0);
  });
});
