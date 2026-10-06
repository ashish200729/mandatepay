import { test, expect, type Page } from "@playwright/test";

const reason = "Recovering a sandbox payment after a lost provider response.";

async function confirmReason(page: Page, title: string, actionLabel: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: actionLabel, exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Action completed|Action pending/ }),
  ).toBeVisible();
}

test("admin can recover payments and webhooks without duplicating captures or refunds", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = (await (await request.get("http://127.0.0.1:4121/__admin_fixture")).json()) as {
    paymentId: string;
    pendingPaymentId: string;
    retryWebhookId: string;
    webhookSecret: string;
  };
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );

  await page.goto(`/payments/${fixture.pendingPaymentId}`);
  await expect(
    page.getByRole("heading", { name: `Payment ${fixture.pendingPaymentId}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reconcile with PayPal" }).click();
  await confirmReason(page, "Reconcile with PayPal", "Reconcile");
  await expect(page.getByText("APPROVED", { exact: false }).first()).toBeVisible();

  await page.goto(`/payments/${fixture.paymentId}`);
  await expect(page.getByRole("heading", { name: `Payment ${fixture.paymentId}` })).toBeVisible();
  await page.getByRole("button", { name: "Initiate remaining refund" }).click();
  const refund = page.getByRole("dialog", { name: "Initiate remaining refund" });
  await expect(refund).toBeVisible();
  await refund.getByLabel("Reason").fill(reason);
  await refund.getByLabel("Amount confirmation").fill("80.00");
  await refund.getByLabel("Target confirmation").fill(fixture.paymentId);
  await refund.getByRole("button", { name: "Review action" }).click();
  await refund.getByRole("button", { name: "Refund remaining amount", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Action completed|Action pending/ }),
  ).toBeVisible();
  await expect(page.getByText("REFUNDED", { exact: false }).first()).toBeVisible();

  await page.goto(`/webhooks/${fixture.retryWebhookId}`);
  await expect(
    page.getByRole("heading", { name: `Webhook event ${fixture.retryWebhookId}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await confirmReason(page, "Retry webhook processing", "Retry processing");
  await expect(page.locator("body")).not.toContainText(fixture.webhookSecret);

  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Admin audit" })).toBeVisible();
  await expect(page.locator("body")).toContainText("ADMIN_PAYMENT_RECONCILE_REQUESTED");
  await expect(page.locator("body")).toContainText("ADMIN_REFUND_REQUESTED");
  await expect(page.locator("body")).toContainText("ADMIN_WEBHOOK_RETRY_REQUESTED");
  await expect(page.locator("body")).not.toContainText(fixture.webhookSecret);
  expect(errors).toEqual([]);
});
