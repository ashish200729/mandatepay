import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPayPalWebhookRoutes } from "./webhooks.js";

describe("PayPal webhook route parser", () => {
  it("captures raw JSON in an encapsulated parser without changing other routes", async () => {
    const app = Fastify({ logger: false });
    const handle = vi.fn().mockResolvedValue({ statusCode: 200, body: { status: "processed" } });
    registerPayPalWebhookRoutes(app, { handle } as never);
    app.post("/other-json", async (request) => ({ body: request.body }));
    await app.ready();

    const payload = '{"id":"EVENT-1","resource":{"id":"RESOURCE-1"}}';
    const webhook = await app.inject({
      method: "POST",
      url: "/api/webhooks/paypal",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(webhook.statusCode).toBe(200);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ rawBody: payload }));

    const other = await app.inject({
      method: "POST",
      url: "/other-json",
      headers: { "content-type": "application/json" },
      payload: { ok: true },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ body: { ok: true } });
    await app.close();
  });

  it("enforces the route body limit", async () => {
    const app = Fastify({ logger: false });
    registerPayPalWebhookRoutes(app, { handle: vi.fn() } as never);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/paypal",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x".repeat(1_000_001) }),
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
