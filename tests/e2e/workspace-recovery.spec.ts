import { expect, test } from "@playwright/test";
import type { PaymentRecord } from "../../apps/web/src/lib/payments/types";

const configured =
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  /:4100(?:\/|$)/.test(process.env.MANDATEPAY_E2E_API_URL ?? "") &&
  Boolean(process.env.TEST_DATABASE_URL);

test("keeps approved-order capture available after reopening without submitting automatically", async ({
  page,
}) => {
  test.skip(!configured, "Requires isolated E2E authentication and PostgreSQL.");
  const suffix = crypto.randomUUID();
  expect(
    (
      await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
        headers: {
          origin: "http://127.0.0.1:3100",
          "x-forwarded-for": `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`,
        },
        data: {
          name: "Order recovery test",
          email: `order-recovery-${suffix}@mandatepay.local`,
          password: `Test-${suffix}-password`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  // These receipts and capture responses are synthetic, never live PayPal.
  let payment: PaymentRecord = {
    id: "approved-order-recovery",
    proposalId: "approved-proposal-recovery",
    status: "APPROVED",
    amount: 13900,
    currency: "USD",
    paypalOrderId: "RECOVERY-ORDER",
    paypalCaptureId: null,
    capturedAt: null,
    createdAt: "2026-10-04T05:00:00.000Z",
    product: {
      title: "Fixture headphones",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
    },
    mandate: { title: "Fixture permission", version: 1 },
    refunds: [],
  };
  let captures = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/orders/approved-order-recovery", (route) =>
    route.fulfill({ json: { payment } }),
  );
  await page.route("**/api/paypal/orders/approved-order-recovery/capture", async (route) => {
    captures += 1;
    expect(route.request().postDataJSON()).toEqual({});
    await gate;
    payment = { ...payment, status: "COMPLETED", paypalCaptureId: "RECOVERY-CAPTURE" };
    await route.fulfill({ json: { payment } });
  });
  const action = page.getByRole("button", { name: "Complete Sandbox payment", exact: true });
  await page.goto("/orders/approved-order-recovery");
  await expect(page.getByText("PayPal approved this order.", { exact: true })).toBeVisible();
  await expect(action).toBeEnabled();
  await page.reload();
  await expect(action).toBeEnabled();
  expect(captures).toBe(0);
  for (const status of ["CREATED", "DENIED", "FAILED", "CANCELLED", "VOIDED", "EXPIRED"]) {
    payment = { ...payment, status };
    await page.goto(
      `/orders/approved-order-recovery${status === "CREATED" ? "" : "?paypal=return"}`,
    );
    await expect(page.getByRole("heading", { name: "Fixture headphones" })).toBeVisible();
    await expect(action).toHaveCount(0);
  }
  payment = { ...payment, status: "APPROVED" };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/approved-order-recovery");
  await expect(action).toBeEnabled();
  await action.click();
  await expect(page.getByRole("button", { name: "Confirming capture…" })).toBeDisabled();
  expect(captures).toBe(1);
  release();
  await expect(page.getByText("Server confirmed capture", { exact: true })).toBeVisible();
  await expect(action).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Server confirmed capture", { exact: true })).toBeVisible();
  await expect(action).toHaveCount(0);
  expect(captures).toBe(1);
});

test("recovers uncertain refunds with a stable request and a read-only status check", async ({
  page,
}, testInfo) => {
  test.skip(!configured, "Requires isolated E2E authentication and PostgreSQL.");
  const suffix = crypto.randomUUID();
  expect(
    (
      await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
        headers: {
          origin: "http://127.0.0.1:3100",
          "x-forwarded-for": `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`,
        },
        data: {
          name: "Refund recovery test",
          email: `refund-recovery-${suffix}@mandatepay.local`,
          password: `Test-${suffix}-password`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  let payment: PaymentRecord = {
    id: "refund-recovery",
    proposalId: "refund-proposal-recovery",
    status: "COMPLETED",
    amount: 13900,
    currency: "USD",
    paypalOrderId: "RECOVERY-ORDER",
    paypalCaptureId: "RECOVERY-CAPTURE",
    capturedAt: "2026-10-04T06:00:00.000Z",
    createdAt: "2026-10-04T05:00:00.000Z",
    product: {
      title: "Fixture headphones",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
    },
    mandate: { title: "Fixture permission", version: 1 },
    refunds: [],
  };
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/orders/refund-recovery", (route) =>
    route.fulfill({ json: { payment } }),
  );
  await page.route("**/api/payments/refund-recovery/refund-status", (route) =>
    route.fulfill({ json: { payment } }),
  );
  await page.route("**/api/payments/refund-recovery/refund", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1)
      return route.fulfill({
        status: 503,
        json: {
          error:
            "The refund outcome has not been confirmed. Refresh this order to check its status before retrying.",
        },
      });
    const refund = {
      id: "pending-refund",
      status: "SUBMITTED",
      amount: 13900,
      currency: "USD" as const,
      paypalRefundId: null,
    };
    payment = { ...payment, refunds: [refund] };
    await route.fulfill({ status: 202, json: { refund, payment, pending: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/refund-recovery");
  await page.getByLabel("Reason", { exact: true }).fill("Return the test purchase.");
  await page.getByRole("button", { name: "Request refund", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request refund", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm refund", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "outcome has not been confirmed",
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByLabel("Reason", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Check refund status", exact: true }),
  ).toBeEnabled();
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Retry same refund", exact: true }).click();
  await expect(page.getByText("Full refund amount:", { exact: false })).toContainText("$139.00");
  await expect(page.getByText("A refund is awaiting confirmation.", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({
    amountMinor: null,
    confirmed: true,
    reason: "Return the test purchase.",
  });
  expect(requests[0]).not.toHaveProperty("displayAmountMinor");
  await page.screenshot({
    path: testInfo.outputPath("refund-recovery-mobile.png"),
    fullPage: true,
  });
  payment = {
    ...payment,
    status: "REFUNDED",
    refunds: [{ ...payment.refunds[0]!, status: "COMPLETED", paypalRefundId: "RECOVERY-REFUND" }],
  };
  await page.getByRole("button", { name: "Check refund status", exact: true }).click();
  await expect(page.getByText("REFUNDED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry same refund", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request refund", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2);
});

test("expires capture controls on time while keeping uncertain payment recovery read-only", async ({
  page,
}, testInfo) => {
  test.skip(!configured, "Requires isolated E2E authentication and PostgreSQL.");
  const suffix = crypto.randomUUID();
  expect(
    (
      await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
        headers: {
          origin: "http://127.0.0.1:3100",
          "x-forwarded-for": `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`,
        },
        data: {
          name: "Payment expiry test",
          email: `expiry-${suffix}@mandatepay.local`,
          password: `Test-${suffix}-password`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  const clockAt = Date.now();
  await page.clock.install({ time: clockAt });
  let payment: PaymentRecord = {
    id: "expiry-recovery",
    proposalId: "expiry-proposal",
    status: "APPROVED",
    amount: 13900,
    currency: "USD",
    paypalOrderId: "EXPIRY-ORDER",
    paypalCaptureId: null,
    capturedAt: null,
    createdAt: new Date(clockAt).toISOString(),
    authorizationExpiresAt: new Date(clockAt + 60000).toISOString(),
    product: {
      title: "Expiry fixture headphones",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
    },
    mandate: { title: "Fixture permission", version: 1 },
    refunds: [],
  };
  let mutations = 0;
  let checks = 0;
  await page.route("**/api/orders/expiry-recovery", (route) =>
    route.fulfill({ json: { payment } }),
  );
  await page.route("**/api/paypal/orders/expiry-recovery/capture", (route) => {
    mutations++;
    return route.fulfill({ status: 503, json: { error: "Unexpected capture" } });
  });
  await page.route("**/api/paypal/orders/expiry-recovery/reconcile", (route) => {
    checks++;
    payment = { ...payment, status: "COMPLETED", paypalCaptureId: "EXISTING-CAPTURE" };
    return route.fulfill({ json: { payment, pending: false } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/orders/expiry-recovery");
  await expect(
    page.getByRole("button", { name: "Complete Sandbox payment", exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(61000);
  await expect(
    page.getByRole("button", { name: "Complete Sandbox payment", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a new proposal", exact: true })).toBeVisible();
  payment = { ...payment, status: "CAPTURE_PENDING", paypalCaptureId: "PENDING-CAPTURE" };
  await page.reload();
  await expect(page.getByRole("link", { name: "Start a new proposal", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Server confirmed capture", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Refunds are unavailable until this payment is captured.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("Server confirmed capture", { exact: true })).toBeVisible();
  expect(checks).toBe(1);
  expect(mutations).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("payment-recovery-mobile.png"),
    fullPage: true,
  });
});

test("confirms settings only after saving, recovers a failed update, and persists the permission", async ({
  page,
}) => {
  test.skip(!configured, "Requires isolated E2E authentication and PostgreSQL.");
  const suffix = crypto.randomUUID();
  expect(
    (
      await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
        headers: {
          origin: "http://127.0.0.1:3100",
          "x-forwarded-for": `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`,
        },
        data: {
          name: "Settings recovery test",
          email: `settings-${suffix}@mandatepay.local`,
          password: `Test-${suffix}-password`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (++attempts === 1) {
      await gate;
      return route.fulfill({
        status: 503,
        json: { error: "Permission could not be saved. Try again." },
      });
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await page.goto("/settings");
  const control = page.getByRole("switch", { name: "Automatic purchase permissions" });
  await control.click();
  await expect(control).toBeDisabled();
  await expect(control).not.toBeChecked();
  release();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Permission could not be saved",
  );
  await expect(control).toBeEnabled();
  await control.click();
  await expect(page.getByText("Automatic permissions are on", { exact: true })).toBeVisible();
  await page.reload();
  await expect(control).toBeChecked();
  await page.goto("/orders/new");
  await expect(page.getByRole("heading", { name: "Choose a proposal first." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review proposals", exact: true })).toBeVisible();
  let reads = 0;
  let financialMutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/paypal/orders"))
      financialMutations += 1;
  });
  await page.route("**/api/proposals/checkout-recovery", (route) =>
    route.fulfill(
      ++reads === 1
        ? { status: 503, json: { error: "Proposal could not be loaded. Try again." } }
        : {
            json: {
              proposal: {
                id: "checkout-recovery",
                status: "AUTHORIZED",
                total: 13900,
                currency: "USD",
                quantity: 1,
                shipping: 0,
                tax: 0,
                expiresAt: null,
                approvalExpiresAt: null,
                product: {
                  title: "Fixture headphones",
                  brand: "Sony",
                  condition: "NEW",
                  merchant: "Mandate Demo Store",
                  source: "demo",
                },
                mandate: { title: "Fixture permission", version: 1 },
              },
              decision: { decision: "ALLOW", reasonCodes: [] },
            },
          },
    ),
  );
  await page.route("**/api/paypal/status", (route) =>
    route.fulfill({ json: { configured: true, environment: "sandbox", webhookConfigured: false } }),
  );
  await page.goto("/orders/new?proposalId=checkout-recovery");
  await expect(page.getByRole("heading", { name: "Checkout unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open PayPal Sandbox", exact: true }),
  ).toBeVisible();
  expect(financialMutations).toBe(0);
  const pendingOrder: PaymentRecord = {
    id: "checkout-unknown",
    proposalId: "checkout-recovery",
    status: "CREATED",
    amount: 13900,
    currency: "USD",
    paypalOrderId: null,
    paypalCaptureId: null,
    capturedAt: null,
    createdAt: "2026-10-04T06:00:00Z",
    product: {
      title: "Fixture headphones",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
    },
    mandate: { title: "Fixture permission", version: 1 },
    refunds: [],
  };
  await page.route("**/api/paypal/orders", (route) =>
    route.fulfill({
      status: 202,
      json: { payment: pendingOrder, approvalUrl: null, pending: true },
    }),
  );
  await page.route("**/api/orders/checkout-unknown", (route) =>
    route.fulfill({ json: { payment: pendingOrder } }),
  );
  await page.getByRole("button", { name: "Open PayPal Sandbox", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/checkout-unknown$/);
  await expect(page.getByRole("link", { name: "Return to checkout", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete Sandbox payment" })).toHaveCount(0);
  expect(financialMutations).toBe(1);
});
