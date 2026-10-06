import { test, expect, type Page } from "@playwright/test";

async function confirm(page: Page, title: string, actionLabel: string, typed?: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Closing a control during an isolated operations check.");
  if (typed) await dialog.getByLabel("Target confirmation").fill(typed);
  if (typed) await dialog.getByRole("button", { name: "Review action" }).click();
  await dialog.getByRole("button", { name: actionLabel, exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Action completed|Action pending/ }),
  ).toBeVisible();
}

test("admin can see the platform mode and change controls from the settings page", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Platform controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn Registration off" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Current platform mode" })).toContainText(
    "Normal operation",
  );
  await page.getByRole("link", { name: "Review controls" }).click();
  await expect(page.getByRole("heading", { name: "Platform controls" })).toBeVisible();

  await page.getByRole("button", { name: "Turn Registration off" }).click();
  await confirm(page, "Turn Registration off", "Turn off");
  await expect(
    page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Registration", exact: true }),
    }),
  ).toContainText("Off");

  await page.getByRole("button", { name: "Turn Checkout off" }).click();
  await confirm(page, "Turn Checkout off", "Turn off", "payments.checkoutEnabled");
  await expect(
    page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Checkout", exact: true }),
    }),
  ).toContainText("Off");

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Current platform mode" })).toContainText(
    "checkout is off",
  );
  await page.goto("/audit");
  await expect(page.locator("body")).toContainText("ADMIN_FEATURE_FLAG_CHANGED");
  expect(errors).toEqual([]);
});
