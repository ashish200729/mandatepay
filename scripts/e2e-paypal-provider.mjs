import { randomUUID } from "node:crypto";

/** In-memory test transport only. Never imported by the production server. */
export function createE2ePayPalProvider() {
  const orders = new Map();
  const captures = new Map();
  const refunds = new Map();
  const requests = new Map();
  const counters = { orders: 0, captures: 0, refunds: 0 };
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const id = (prefix) => prefix + randomUUID().replaceAll("-", "").slice(0, 14).toUpperCase();
  function orderResult(order) {
    return {
      id: order.id,
      status: order.capture ? "COMPLETED" : "APPROVED",
      links: [
        { rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` },
      ],
      purchase_units: [
        { ...order.unit, ...(order.capture ? { payments: { captures: [order.capture] } } : {}) },
      ],
    };
  }
  async function transport(url, init = {}) {
    const target = new URL(String(url));
    if (target.origin !== "https://api-m.sandbox.paypal.com")
      throw new Error("Unexpected test provider origin");
    const path = target.pathname;
    const body = init.body
      ? JSON.parse(String(init.body).startsWith("grant_type=") ? "null" : String(init.body))
      : null;
    if (path === "/v1/oauth2/token")
      return response({ access_token: "e2e-only-token", token_type: "Bearer", expires_in: 3600 });
    if (path === "/v1/notifications/verify-webhook-signature")
      return response({
        verification_status:
          body?.transmission_sig === "e2e-valid-signature" ? "SUCCESS" : "FAILURE",
      });
    const requestId = new Headers(init.headers).get("paypal-request-id");
    if (init.method === "POST" && requestId && requests.has(requestId))
      return response(requests.get(requestId));
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const order = {
        id: id("ORD"),
        unit: body.purchase_units[0],
        returnUrl: body.application_context.return_url,
        capture: null,
      };
      orders.set(order.id, order);
      counters.orders += 1;
      const result = { ...orderResult(order), status: "CREATED" };
      requests.set(requestId, result);
      return response(result, 201);
    }
    const orderMatch = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(path);
    if (orderMatch) {
      const order = orders.get(orderMatch[1]);
      if (!order) return response({ error: "Unknown fixture order" }, 404);
      if (orderMatch[2] && init.method === "POST") {
        if (!order.capture) {
          order.capture = {
            id: id("CAP"),
            status: "COMPLETED",
            amount: order.unit.amount,
            custom_id: order.unit.custom_id,
            create_time: new Date().toISOString(),
          };
          captures.set(order.capture.id, { ...order.capture, orderId: order.id, refunded: 0 });
          counters.captures += 1;
        }
        const result = orderResult(order);
        requests.set(requestId, result);
        return response(result, 201);
      }
      return response(orderResult(order));
    }
    const captureMatch = /^\/v2\/payments\/captures\/([^/]+)(\/refund)?$/.exec(path);
    if (captureMatch) {
      const capture = captures.get(captureMatch[1]);
      if (!capture) return response({ error: "Unknown fixture capture" }, 404);
      if (captureMatch[2] && init.method === "POST") {
        const amount = Math.round(Number(body.amount.value) * 100);
        const original = Math.round(Number(capture.amount.value) * 100);
        if (amount <= 0 || capture.refunded + amount > original)
          return response({ error: "Fixture refund limit" }, 422);
        const refund = {
          id: id("REF"),
          status: "COMPLETED",
          amount: body.amount,
          invoice_id: body.invoice_id,
          capture_id: capture.id,
          create_time: new Date().toISOString(),
        };
        capture.refunded += amount;
        capture.status = capture.refunded === original ? "REFUNDED" : "PARTIALLY_REFUNDED";
        refunds.set(refund.id, refund);
        requests.set(requestId, refund);
        counters.refunds += 1;
        return response(refund, 201);
      }
      return response(capture);
    }
    const refundMatch = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path);
    if (refundMatch && refunds.has(refundMatch[1])) return response(refunds.get(refundMatch[1]));
    return response({ error: "Unexpected fixture endpoint" }, 404);
  }
  return { transport, counters, returnUrl: (orderId) => orders.get(orderId)?.returnUrl ?? null };
}
