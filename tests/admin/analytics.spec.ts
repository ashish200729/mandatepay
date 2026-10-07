import { test, expect } from "@playwright/test";

test("admin dashboard charts use a time range and drill into filtered lists", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Time range" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Operational charts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "User growth" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment volume" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Purchasing and payments" }).click();
  await expect(page.getByRole("heading", { name: "Approval funnel" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByLabel("Time period").locator("option:checked")).toHaveText("Last 30 days");
  await page.getByLabel("Time period").selectOption({ label: "Last 7 days" });
  await expect(page).toHaveURL(/from=/u);
  await page.locator("summary").filter({ hasText: "Purchasing and payments" }).click();
  await page.locator("summary").filter({ hasText: "Webhooks and recovery" }).click();
  await page.locator("summary").filter({ hasText: "Customers and agents" }).click();
  await expect(page.getByRole("heading", { name: "AgentGuard decisions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top error categories" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mandate status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent runs" })).toBeVisible();
  const growth = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "User growth" }) });
  await growth.getByRole("link", { name: "View records" }).click();
  await expect(page).toHaveURL(/\/users\?/u);
  await expect(page).toHaveURL(/from=/u);
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
