import { expect, test } from "@playwright/test";
import { captureWorkspace } from "./workspace-capture";

const authApiUrl = process.env.MANDATEPAY_E2E_API_URL ?? process.env.API_URL ?? "";
const authConfigured =
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  /:4100(?:\/|$)/.test(authApiUrl) &&
  Boolean(process.env.TEST_DATABASE_URL);

test.describe("authenticated workspace flow", () => {
  test.beforeEach(() => {
    test.skip(
      !authConfigured,
      "Requires MANDATEPAY_E2E_AUTH=1, TEST_DATABASE_URL, and an API_URL on port 4100; never run against a developer database.",
    );
  });

  test("signs up in the isolated auth database, signs in, and signs out", async ({
    page,
  }, testInfo) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-${suffix}@mandatepay.local`;
    const password = `Test-${suffix}-password`;

    await page.goto("/signup?returnTo=%2Fchat");
    await page.getByLabel("Name").fill("MandatePay E2E");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your shopping brief starts here." }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    const autonomySwitch = page.getByRole("switch", {
      name: "Automatic purchase permissions",
    });
    await expect(autonomySwitch).toBeVisible();
    await expect(autonomySwitch).not.toBeChecked();
    await captureWorkspace(page, testInfo, "settings");
    await autonomySwitch.click();
    await expect(autonomySwitch).toBeChecked();
    await expect(page.getByText("Automatic permissions are on", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Automatic purchase permissions" }),
    ).toBeChecked();

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/signin\?returnTo=%2Fchat$/);
    await expect(page.getByRole("heading", { name: "Keep the final say." })).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/chat$/);
  });
});
