import { expect, test } from "@playwright/test";

const configured =
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  /:4100(?:\/|$)/.test(process.env.MANDATEPAY_E2E_API_URL ?? "") &&
  Boolean(process.env.TEST_DATABASE_URL);
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
          "x-forwarded-for": `192.0.2.${200 + test.info().parallelIndex}`,
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
});
