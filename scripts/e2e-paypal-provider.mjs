import { randomUUID } from "node:crypto";

/** In-memory test transport only. Never imported by the production server. */
export function createE2ePayPalProvider() {
  const orders = new Map();
  const captures = new Map();
  const refunds = new Map();
  const requests = new Map();
  // Simulated PayPal Vault: setup tokens (buyer consent) and saved payment tokens.
  const setupTokens = new Map();
  const paymentTokens = new Map();
  const counters = { orders: 0, captures: 0, refunds: 0 };
  // Vault charges are counted separately so parallel specs asserting checkout counters stay exact.
  const vaultCounters = { orders: 0, captures: 0, deletedTokens: 0 };
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
    if (path === "/v3/vault/setup-tokens" && init.method === "POST") {
      const setup = {
        id: id("SETUP"),
        returnUrl: body.payment_source?.paypal?.experience_context?.return_url ?? null,
      };
      setupTokens.set(setup.id, setup);
      const result = {
        id: setup.id,
        status: "PAYER_ACTION_REQUIRED",
        customer: { id: "customer_e2e" },
        links: [
          {
            rel: "approve",
            href: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${setup.id}`,
            method: "GET",
          },
        ],
      };
      requests.set(requestId, result);
      return response(result, 201);
    }
    if (path === "/v3/vault/payment-tokens" && init.method === "POST") {
      const setupId = body?.payment_source?.token?.id;
      if (!setupTokens.has(setupId) || body.payment_source.token.type !== "SETUP_TOKEN")
        return response(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SETUP_TOKEN_NOT_APPROVED" }] },
          422,
        );
      const token = {
        id: id("VTOK"),
        customer: { id: "customer_e2e" },
        payment_source: { paypal: { email_address: "sandbox-buyer@example.com" } },
      };
      paymentTokens.set(token.id, token);
      requests.set(requestId, token);
      return response(token, 201);
    }
    const tokenMatch = /^\/v3\/vault\/payment-tokens\/([^/]+)$/.exec(path);
    if (tokenMatch) {
      const token = paymentTokens.get(tokenMatch[1]);
      if (!token) return response({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (init.method === "DELETE") {
        paymentTokens.delete(token.id);
        vaultCounters.deletedTokens += 1;
        return new Response(null, { status: 204 });
      }
      return response(token);
    }
    const vaultId = body?.payment_source?.paypal?.vault_id;
    if (path === "/v2/checkout/orders" && init.method === "POST" && vaultId) {
      // Buyer not present: a saved token completes the capture in the create response.
      if (!paymentTokens.has(vaultId))
        return response(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYMENT_SOURCE_CANNOT_BE_USED" }] },
          422,
        );
      const order = { id: id("ORD"), unit: body.purchase_units[0], returnUrl: null, capture: null };
      order.capture = {
        id: id("CAP"),
        status: "COMPLETED",
        amount: {
          currency_code: order.unit.amount.currency_code,
          value: order.unit.amount.value,
        },
        custom_id: order.unit.custom_id,
        create_time: new Date().toISOString(),
      };
      orders.set(order.id, order);
      captures.set(order.capture.id, { ...order.capture, orderId: order.id, refunded: 0 });
      vaultCounters.orders += 1;
      vaultCounters.captures += 1;
      const result = orderResult(order);
      requests.set(requestId, result);
      return response(result, 201);
    }
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const order = {
        id: id("ORD"),
        unit: body.purchase_units[0],
        returnUrl:
          body.payment_source?.paypal?.experience_context?.return_url ??
          body.application_context?.return_url,
        capture: null,
      };
      orders.set(order.id, order);
      counters.orders += 1;
      // Like PayPal with payment_source.paypal: the buyer redirect is rel "payer-action".
      const result = {
        ...orderResult(order),
        status: "PAYER_ACTION_REQUIRED",
        links: [
          {
            rel: "payer-action",
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`,
          },
        ],
      };
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
            // PayPal reports a capture's total only; the breakdown stays on the order amount.
            amount: {
              currency_code: order.unit.amount.currency_code,
              value: order.unit.amount.value,
            },
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
  return {
    transport,
    counters,
    vaultCounters,
    returnUrl: (orderId) =>
      orders.get(orderId)?.returnUrl ?? setupTokens.get(orderId)?.returnUrl ?? null,
  };
}
