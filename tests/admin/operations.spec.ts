import { test, expect } from "@playwright/test";

test("admin can inspect the user-to-refund operations chain", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = (await (await request.get("http://127.0.0.1:4121/__admin_fixture")).json()) as {
    normalEmail: string;
    originalPrompt: string;
    webhookSecret: string;
    ownerUserId: string;
    mandateId: string;
    proposalId: string;
    approvalId: string;
    paymentId: string;
    refundId: string;
    webhookId: string;
  };
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  const related = (name: string) =>
    page
      .getByRole("navigation", { name: "Related records" })
      .getByRole("link", { name, exact: true });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Subsystem warnings" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "More metrics" }).click();
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Agent requests" }) }),
  ).toContainText("Agent runs started");
  await expect(page.locator("body")).not.toContainText(fixture.originalPrompt);
  await page.screenshot({ path: testInfo.outputPath("desktop-overview.png"), fullPage: true });

  await page
    .getByRole("navigation", { name: "Administration" })
    .getByRole("link", { name: "Users", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await page.getByLabel("Search name or email").fill(fixture.normalEmail);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(fixture.normalEmail), "u"));
  await page.getByRole("link", { name: fixture.ownerUserId, exact: true }).first().click();
  await expect(page.getByRole("heading", { name: `User ${fixture.ownerUserId}` })).toBeVisible();
  await related("Mandates").click();
  await expect(page.getByRole("heading", { name: "Mandates", exact: true })).toBeVisible();
  await page.getByRole("link", { name: fixture.mandateId, exact: true }).first().click();
  await expect(page.getByRole("heading", { name: `Mandate ${fixture.mandateId}` })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(fixture.originalPrompt);
  await related("Related proposals").click();
  await page.getByRole("link", { name: fixture.proposalId, exact: true }).first().click();
  await expect(page.getByRole("heading", { name: `Proposal ${fixture.proposalId}` })).toBeVisible();
  await page.getByRole("link", { name: fixture.approvalId, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Approval ${fixture.approvalId}` })).toBeVisible();
  await related("Payment").click();
  await page.getByRole("link", { name: fixture.paymentId, exact: true }).first().click();
  await expect(page.getByRole("heading", { name: `Payment ${fixture.paymentId}` })).toBeVisible();
  await related("Refunds").click();
  await page.getByRole("link", { name: fixture.refundId, exact: true }).first().click();
  await expect(page.getByRole("heading", { name: `Refund ${fixture.refundId}` })).toBeVisible();
  await page.getByRole("link", { name: fixture.paymentId, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Payment ${fixture.paymentId}` })).toBeVisible();

  await page.goto(`/webhooks/${fixture.webhookId}`);
  await expect(
    page.getByRole("heading", { name: `Webhook event ${fixture.webhookId}` }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(fixture.webhookSecret);
  await expect(page.getByRole("link", { name: fixture.paymentId, exact: true })).toBeVisible();

  await page.goto("/users?limit=1");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/u);
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Admin audit", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
