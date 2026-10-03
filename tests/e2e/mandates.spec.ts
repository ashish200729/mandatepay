import { expect, test } from "@playwright/test";

const isolatedApiUrl = process.env.MANDATEPAY_E2E_API_URL ?? process.env.API_URL ?? "";
const mandatesConfigured =
  process.env.MANDATEPAY_E2E_MANDATES === "1" &&
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  process.env.MANDATEPAY_E2E_MOCK_PARSER === "1" &&
  /:4100(?:\/|$)/.test(isolatedApiUrl) &&
  Boolean(process.env.TEST_DATABASE_URL);

test.describe("mandate workflow", () => {
  test.beforeEach(() => {
    test.skip(
      !mandatesConfigured,
      "Requires the isolated PostgreSQL/API:4100 stack and the explicit mandate parser test fixture.",
    );
  });

  test("parses, reviews, saves, activates, and reopens a mandate", async ({ page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `mandate-e2e-${suffix}@mandatepay.local`;
    const password = `Test-${suffix}-password`;

    await page.goto("/signup?returnTo=%2Fmandates%2Fnew");
    await page.getByLabel("Name").fill("Mandate Workflow E2E");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/mandates\/new$/);
    await page
      .getByLabel("What should your agent be allowed to buy?")
      .fill(
        "Find Sony or Bose noise-cancelling headphones under $180. Buy new only. Automatically spend up to $150 and ask me above that.",
      );
    await page.getByRole("button", { name: "Review mandate" }).click();

    await expect(
      page.getByRole("heading", { name: "These are the permissions your agent will receive." }),
    ).toBeVisible();
    await expect(page.getByText("Original instruction")).toBeVisible();
    await expect(page.getByLabel("Maximum transaction")).toHaveValue("180.00");
    await expect(page.getByLabel("Automatic spending")).toHaveValue("150.00");

    await page.getByLabel(/I have reviewed these exact permissions/).check();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();

    await page.getByRole("button", { name: "Activate mandate" }).click();
    await expect(page).toHaveURL(/\/mandates\/[^/]+$/);
    await expect(page.getByText("ACTIVE")).toBeVisible();
    await expect(page.getByText("Original instruction")).toBeVisible();

    await page.getByRole("button", { name: "Edit permissions" }).click();
    await page.getByLabel("Maximum transaction").fill("190.00");
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect(page.getByText(/Version 2 · UTC/)).toBeVisible();
    await expect(page.getByText("$190.00")).toBeVisible();

    await page.getByRole("button", { name: "Pause mandate" }).click();
    await expect(page.getByText("PAUSED")).toBeVisible();
    await page.getByRole("button", { name: "Resume mandate" }).click();
    await expect(page.getByText("ACTIVE")).toBeVisible();
    const mandateDetailUrl = page.url();

    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await page.getByLabel("Search products").fill("headphones");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText(/Demo Catalog — illustrative products/)).toBeVisible();
    const comparisons = page.getByRole("checkbox", { name: "Compare", exact: true });
    await expect(comparisons).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) await comparisons.nth(index).check();
    await page.getByRole("button", { name: "Compare selected (3)" }).click();
    await expect(page.getByRole("heading", { name: "Comparison ready." })).toBeVisible();
    await page
      .getByRole("button", { name: /Prepare proposal/ })
      .nth(1)
      .click();
    await expect(page.getByText("REQUIRE_APPROVAL", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Approvals", exact: true }).click();
    await expect(page).toHaveURL(/\/approvals$/);
    await page.getByRole("button", { name: "Review proposal" }).click();
    await page.getByRole("button", { name: "Approve proposal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Approve this proposal?" })).toBeVisible();
    await page.getByRole("button", { name: "Yes, approve", exact: true }).click();
    await expect(
      page.getByRole("region").getByRole("link", { name: "Continue to Sandbox checkout" }),
    ).toBeVisible();
    // This scenario uses the isolated simulated provider, never live PayPal credentials.
    await page.route("https://www.sandbox.paypal.com/checkoutnow?*", async (route) => {
      const token = new URL(route.request().url()).searchParams.get("token");
      const response = await page.request.get(`${isolatedApiUrl}/__e2e/paypal/return-url/${token}`);
      expect(response.ok()).toBeTruthy();
      const { url } = await response.json();
      await route.fulfill({ status: 302, headers: { location: url }, body: "" });
    });
    await page
      .getByRole("region")
      .getByRole("link", { name: "Continue to Sandbox checkout" })
      .click();
    await expect(page.getByRole("heading", { name: "Confirm your purchase." })).toBeVisible();
    await page.getByRole("button", { name: "Open PayPal Sandbox" }).click();
    await expect(page).toHaveURL(/\/orders\/[^/?]+\?paypal=return$/);
    await page.getByRole("button", { name: "Complete Sandbox payment" }).click();
    await expect(page.getByText("Server confirmed capture", { exact: true })).toBeVisible();
    const paymentId = new URL(page.url()).pathname.split("/").at(-1);
    const receipt = await (await page.request.get(`/api/orders/${paymentId}`)).json();
    const event = {
      id: `capture-e2e-${suffix}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: receipt.payment.paypalCaptureId,
        supplementary_data: { related_ids: { order_id: receipt.payment.paypalOrderId } },
      },
    };
    const hook = {
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "e2e-transmission",
        "paypal-transmission-time": new Date().toISOString(),
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/e2e",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "e2e-valid-signature",
      },
      data: event,
    };
    expect((await page.request.post(`${isolatedApiUrl}/api/webhooks/paypal`, hook)).status()).toBe(
      200,
    );
    expect((await page.request.post(`${isolatedApiUrl}/api/webhooks/paypal`, hook)).status()).toBe(
      200,
    );
    await page.getByRole("radio", { name: "Partial refund", exact: true }).check();
    await page.getByLabel("Refund amount", { exact: true }).fill("20.00");
    await page.getByLabel("Reason", { exact: true }).fill("One item was damaged.");
    await page.getByRole("button", { name: "Request refund", exact: true }).click();
    await page.getByRole("button", { name: "Confirm refund", exact: true }).click();
    await expect(page.getByText("PARTIALLY_REFUNDED", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "Full refund", exact: true }).check();
    await page.getByLabel("Reason", { exact: true }).fill("Return the remaining purchase.");
    await page.getByRole("button", { name: "Request refund", exact: true }).click();
    await page.getByRole("button", { name: "Confirm refund", exact: true }).click();
    await expect(page.getByText("REFUNDED", { exact: true })).toBeVisible();
    expect(
      await (await page.request.get(`${isolatedApiUrl}/__e2e/paypal/counters`)).json(),
    ).toEqual({ orders: 1, captures: 1, refunds: 2 });
    await page.goto(mandateDetailUrl);

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("heading", { name: "Revoke this mandate?" })).toBeVisible();
    await page.getByRole("button", { name: "Yes, revoke mandate" }).click();
    await expect(page.getByText("REVOKED")).toBeVisible();

    await page.getByRole("link", { name: "All mandates" }).click();
    await expect(page).toHaveURL(/\/mandates$/);
    await expect(page.getByText("Noise-cancelling headphones", { exact: true })).toBeVisible();
    await expect(page.getByText("REVOKED")).toBeVisible();
    await page.getByRole("link", { name: /Noise-cancelling headphones/ }).click();
    await expect(page.getByText("REVOKED")).toBeVisible();
  });
});
