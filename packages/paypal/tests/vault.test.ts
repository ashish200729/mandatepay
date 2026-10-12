import { describe, expect, it, vi } from "vitest";
import {
  PayPalClient,
  PayPalInputError,
  PayPalProviderError,
  PayPalResponseError,
  PayPalWebhookService,
  SUPPORTED_PAYPAL_WEBHOOK_EVENTS,
  isDefinitivePayPalRejection,
  parsePayPalConfig,
  type PayPalConfig,
  type PayPalWebhookReconciler,
  type WebhookInboxStore,
} from "../src/index.js";

const config = (overrides: Partial<PayPalConfig> = {}): PayPalConfig =>
  parsePayPalConfig({
    environment: "sandbox",
    clientId: "client-test",
    clientSecret: "secret-test",
    webhookId: "webhook-test",
    timeoutMs: 1_000,
    maxRetries: 1,
    ...overrides,
  });

const token = { access_token: "access-token-test", token_type: "Bearer", expires_in: 3600 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(handler: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) return json(token);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetcher, calls };
}

const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);
const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown;
const noSleep = async () => undefined;

const setupResponse = {
  id: "5C991763VB2781612",
  customer: { id: "customer_4029352051" },
  status: "PAYER_ACTION_REQUIRED",
  links: [
    {
      href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2781612",
      rel: "approve",
      method: "GET",
    },
    {
      href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/5C991763VB2781612",
      rel: "self",
      method: "GET",
    },
  ],
};

const paymentTokenResponse = {
  id: "jwgvx42",
  customer: { id: "customer_4029352051" },
  payment_source: { paypal: { email_address: "buyer@example.com", payer_id: "AJM9JTWQJCFTA" } },
  links: [],
};

describe("PayPal Vault client", () => {
  it("creates a setup token with the documented body, request id and validated approve link", async () => {
    const { fetcher, calls } = transport(() => json(setupResponse, 201));
    const client = new PayPalClient(config(), { fetch: fetcher });
    const result = await client.createVaultSetupToken({
      requestId: "setup-request-1",
      returnUrl: "http://localhost:3000/settings?vault=return",
      cancelUrl: "http://localhost:3000/settings?vault=cancel",
    });
    expect(result).toEqual({
      id: "5C991763VB2781612",
      status: "PAYER_ACTION_REQUIRED",
      customerId: "customer_4029352051",
      approvalUrl: setupResponse.links[0]?.href,
    });
    expect(calls[0]?.url).toBe("https://api-m.sandbox.paypal.com/v3/vault/setup-tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header(calls[0]?.init, "paypal-request-id")).toBe("setup-request-1");
    expect(body(calls[0]?.init)).toEqual({
      payment_source: {
        paypal: {
          description: "MandatePay autonomous purchases",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: "MandatePay",
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            return_url: "http://localhost:3000/settings?vault=return",
            cancel_url: "http://localhost:3000/settings?vault=cancel",
          },
        },
      },
    });
  });

  it("rejects an approve link outside the configured environment's buyer hosts", async () => {
    const { fetcher } = transport(() =>
      json({
        ...setupResponse,
        links: [{ href: "https://evil.example/agreements/approve", rel: "approve" }],
      }),
    );
    const client = new PayPalClient(config(), { fetch: fetcher });
    await expect(
      client.createVaultSetupToken({
        requestId: "setup-request-2",
        returnUrl: "http://localhost:3000/settings?vault=return",
        cancelUrl: "http://localhost:3000/settings?vault=cancel",
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL_URL" });

    const live = new PayPalClient(config({ environment: "live" }), {
      fetch: transport(() => json(setupResponse)).fetcher,
    });
    await expect(
      live.createVaultSetupToken({
        requestId: "setup-request-3",
        returnUrl: "https://app.example/settings?vault=return",
        cancelUrl: "https://app.example/settings?vault=cancel",
      }),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL_URL" });
    await expect(
      live.createVaultSetupToken({
        requestId: "setup-request-4",
        returnUrl: "http://localhost:3000/settings?vault=return",
        cancelUrl: "http://localhost:3000/settings?vault=cancel",
      }),
    ).rejects.toBeInstanceOf(PayPalInputError);
  });

  it("exchanges an approved setup token for a payment token idempotently", async () => {
    const { fetcher, calls } = transport(() => json(paymentTokenResponse, 201));
    const client = new PayPalClient(config(), { fetch: fetcher });
    const result = await client.createVaultPaymentToken({
      setupTokenId: "5C991763VB2781612",
      requestId: "token-request-1",
    });
    expect(result).toEqual({
      id: "jwgvx42",
      customerId: "customer_4029352051",
      payerEmail: "buyer@example.com",
    });
    expect(calls[0]?.url).toBe("https://api-m.sandbox.paypal.com/v3/vault/payment-tokens");
    expect(header(calls[0]?.init, "paypal-request-id")).toBe("token-request-1");
    expect(body(calls[0]?.init)).toEqual({
      payment_source: { token: { id: "5C991763VB2781612", type: "SETUP_TOKEN" } },
    });
  });

  it("validates vault identifiers before they reach a URL path", async () => {
    const client = new PayPalClient(config(), { fetch: transport(() => json({})).fetcher });
    await expect(client.deleteVaultPaymentToken("../orders")).rejects.toBeInstanceOf(
      PayPalInputError,
    );
    await expect(
      client.createVaultPaymentToken({ setupTokenId: "a/b", requestId: "r" }),
    ).rejects.toMatchObject({ code: "INVALID_VAULT_INPUT" });
    await expect(client.getVaultPaymentToken("")).rejects.toBeInstanceOf(PayPalInputError);
  });

  it("rejects a malformed payment token response", async () => {
    const client = new PayPalClient(config(), {
      fetch: transport(() => json({ customer: { id: "c" } })).fetcher,
    });
    await expect(
      client.createVaultPaymentToken({ setupTokenId: "SETUP1", requestId: "token-request-2" }),
    ).rejects.toBeInstanceOf(PayPalResponseError);
  });

  it("deletes a payment token, treats 404 as already removed and keeps other errors", async () => {
    let status = 204;
    const { fetcher, calls } = transport(() =>
      status === 204 ? new Response(null, { status: 204 }) : json({ name: "X" }, status),
    );
    const client = new PayPalClient(config(), { fetch: fetcher, sleep: noSleep });
    expect(await client.deleteVaultPaymentToken("jwgvx42")).toEqual({ alreadyAbsent: false });
    expect(calls[0]?.url).toBe("https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/jwgvx42");
    expect(calls[0]?.init?.method).toBe("DELETE");
    status = 404;
    expect(await client.deleteVaultPaymentToken("jwgvx42")).toEqual({ alreadyAbsent: true });
    status = 503;
    const before = calls.length;
    const failure = await client.deleteVaultPaymentToken("jwgvx42").catch((error) => error);
    expect(failure).toBeInstanceOf(PayPalProviderError);
    expect(isDefinitivePayPalRejection(failure)).toBe(false);
    // DELETE is idempotent, so an uncertain failure is retried within the bound.
    expect(calls.length - before).toBe(2);
  });

  it("creates a buyer-not-present order with vault_id, the same breakdown and a request id", async () => {
    const completed = {
      id: "ORDER-VAULT-1",
      status: "COMPLETED",
      links: [],
      purchase_units: [
        {
          reference_id: "payment-1",
          custom_id: "proposal-1",
          amount: { currency_code: "USD", value: "139.00" },
          payments: {
            captures: [
              {
                id: "CAPTURE-VAULT-1",
                status: "COMPLETED",
                amount: { currency_code: "USD", value: "139.00" },
                custom_id: "proposal-1",
                create_time: "2026-10-12T10:00:00Z",
              },
            ],
          },
        },
      ],
    };
    const { fetcher, calls } = transport(() => json(completed, 201));
    const client = new PayPalClient(config(), { fetch: fetcher });
    const order = await client.createVaultOrder({
      amountMinor: 13_900,
      referenceId: "payment-1",
      customId: "proposal-1",
      requestId: "vault-order-request-1",
      vaultId: "jwgvx42",
      items: [{ name: "Headphones", sku: "sku-1", quantity: 1, unitAmountMinor: 13_900 }],
      shippingMinor: 0,
      taxMinor: 0,
    });
    expect(order.status).toBe("COMPLETED");
    expect(order.approvalUrl).toBeNull();
    expect(header(calls[0]?.init, "paypal-request-id")).toBe("vault-order-request-1");
    expect(header(calls[0]?.init, "prefer")).toBe("return=representation");
    expect(body(calls[0]?.init)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "payment-1",
          custom_id: "proposal-1",
          amount: {
            currency_code: "USD",
            value: "139.00",
            breakdown: {
              item_total: { currency_code: "USD", value: "139.00" },
              shipping: { currency_code: "USD", value: "0.00" },
              tax_total: { currency_code: "USD", value: "0.00" },
            },
          },
          items: [
            {
              name: "Headphones",
              quantity: "1",
              unit_amount: { currency_code: "USD", value: "139.00" },
              sku: "sku-1",
            },
          ],
        },
      ],
      payment_source: { paypal: { vault_id: "jwgvx42" } },
    });
  });

  it("refuses an inconsistent vault order breakdown before calling PayPal", async () => {
    const { fetcher, calls } = transport(() => json({}));
    const client = new PayPalClient(config(), { fetch: fetcher });
    await expect(
      client.createVaultOrder({
        amountMinor: 1_000,
        referenceId: "payment-1",
        customId: "proposal-1",
        requestId: "vault-order-request-2",
        vaultId: "jwgvx42",
        items: [{ name: "Item", quantity: 1, unitAmountMinor: 999 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_VAULT_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("classifies a vault-not-enabled rejection as definitive and a 5xx as uncertain", async () => {
    let status = 422;
    const client = new PayPalClient(config({ maxRetries: 0 }), {
      fetch: transport(() =>
        json(
          {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE", description: "free text" }],
            debug_id: "debug-1",
          },
          status,
        ),
      ).fetcher,
    });
    const input = {
      amountMinor: 1_000,
      referenceId: "payment-1",
      customId: "proposal-1",
      requestId: "vault-order-request-3",
      vaultId: "jwgvx42",
    };
    const definitive = await client.createVaultOrder(input).catch((error) => error);
    expect(isDefinitivePayPalRejection(definitive)).toBe(true);
    expect(definitive).toMatchObject({ issue: "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE" });
    expect(JSON.stringify(definitive)).not.toContain("free text");
    status = 500;
    const uncertain = await client.createVaultOrder(input).catch((error) => error);
    expect(isDefinitivePayPalRejection(uncertain)).toBe(false);
    expect(uncertain).toMatchObject({ unknownOutcome: true });
  });
});

describe("PayPal Vault webhooks", () => {
  function setup(getVaultPaymentToken: ReturnType<typeof vi.fn>) {
    const paypal = {
      verifyWebhook: vi.fn().mockResolvedValue(true),
      getVaultPaymentToken,
    } as unknown as PayPalClient;
    const inbox = {
      claim: vi.fn().mockResolvedValue({ id: "inbox-1", shouldProcess: true, status: "RECEIVED" }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn().mockResolvedValue(undefined),
      markIgnored: vi.fn().mockResolvedValue(undefined),
    } as WebhookInboxStore;
    const reconciler = { reconcile: vi.fn().mockResolvedValue("processed") };
    return {
      service: new PayPalWebhookService(
        paypal,
        inbox,
        reconciler as unknown as PayPalWebhookReconciler,
      ),
      reconciler,
    };
  }
  const headers = {
    "paypal-transmission-id": "t",
    "paypal-transmission-time": "2026-10-12T00:00:00Z",
    "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/C",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "s",
  };
  const event = (eventType: string, id = "jwgvx42") =>
    JSON.stringify({ id: "WH-VAULT-1", event_type: eventType, resource: { id } });

  it("supports the Vault payment token events", () => {
    expect(SUPPORTED_PAYPAL_WEBHOOK_EVENTS).toContain("VAULT.PAYMENT-TOKEN.CREATED");
    expect(SUPPORTED_PAYPAL_WEBHOOK_EVENTS).toContain("VAULT.PAYMENT-TOKEN.DELETED");
  });

  it("confirms a deleted token with PayPal's own 404 before reconciling", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValue(new PayPalProviderError("UPSTREAM_REQUEST_FAILED", 404));
    const context = setup(lookup);
    const result = await context.service.handle({
      rawBody: event("VAULT.PAYMENT-TOKEN.DELETED"),
      headers,
    });
    expect(result.statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledWith("jwgvx42");
    expect(context.reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritative: {
          kind: "payment_token",
          eventType: "VAULT.PAYMENT-TOKEN.DELETED",
          tokenId: "jwgvx42",
          token: null,
        },
      }),
    );
  });

  it("re-reads a created token and retries when PayPal is unavailable", async () => {
    const lookup = vi.fn().mockResolvedValue({
      id: "jwgvx42",
      customerId: "customer_1",
      payerEmail: null,
    });
    const context = setup(lookup);
    await context.service.handle({ rawBody: event("VAULT.PAYMENT-TOKEN.CREATED"), headers });
    expect(context.reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritative: expect.objectContaining({
          kind: "payment_token",
          token: { id: "jwgvx42", customerId: "customer_1", payerEmail: null },
        }),
      }),
    );
    const failing = setup(
      vi.fn().mockRejectedValue(new PayPalProviderError("UPSTREAM_UNAVAILABLE", 503)),
    );
    const result = await failing.service.handle({
      rawBody: event("VAULT.PAYMENT-TOKEN.DELETED"),
      headers,
    });
    expect(result.statusCode).toBe(503);
    expect(failing.reconciler.reconcile).not.toHaveBeenCalled();
  });

  it("ignores a vault event whose token id is not a safe identifier", async () => {
    const lookup = vi.fn();
    const context = setup(lookup);
    const result = await context.service.handle({
      rawBody: event("VAULT.PAYMENT-TOKEN.DELETED", "../x"),
      headers,
    });
    expect(result.body).toEqual({ status: "ignored" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
