import { test, expect } from "@playwright/test";

test("admin can review system health, agent activity, and subsystem warnings", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/system");
  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  await expect(page.getByText("PayPal Sandbox", { exact: true })).toBeVisible();
  await expect(page.getByText("Database", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Catalog", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/system");
  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  await expect(page.getByText("PayPal Sandbox", { exact: true })).toBeVisible();
  await expect(page.getByText("Database", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Catalog", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/password|secret|api key|bearer/i);

  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "Agent activity" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Subsystem warnings" })).toBeVisible();
  await page.locator("aside").getByRole("link", { name: "System health" }).click();
  await expect(page.getByRole("heading", { name: "System health" })).toBeVisible();
  expect(errors).toEqual([]);
});
