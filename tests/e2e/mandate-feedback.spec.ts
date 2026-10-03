import { expect, test } from "@playwright/test";

const budgetPrompt =
  "Compare prices for new Sony PlayStation 5 disc and digital editions. Select the cheaper option. Buy only one console. My maximum total budget is $600 USD, including shipping and tax. Ask for my approval before every purchase.";
const readyMandate = {
  title: "PlayStation 5 console",
  productIntent: "Compare PlayStation 5 disc and digital editions and choose the cheaper option",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Sony"],
  blockedBrands: [],
  allowedCategories: [],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: 0,
  transactionLimit: 60000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: true,
};

test.beforeEach(async ({ page }) => {
  const suffix = crypto.randomUUID();
  const response = await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
    headers: {
      origin: "http://127.0.0.1:3100",
      "x-forwarded-for": `192.0.2.${220 + test.info().parallelIndex}`,
    },
    data: {
      name: "Mandate feedback test",
      email: `feedback-${suffix}@mandatepay.local`,
      password: `Test-${suffix}-password`,
    },
  });
  expect(response.ok()).toBeTruthy();
});

for (const width of [1440, 390, 320]) {
  test(`shows and focuses missing information beside the request at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let requests = 0;
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/mandates")) saves += 1;
    });
    await page.route("**/api/mandates/parse", async (route) => {
      const prompt = route.request().postDataJSON().prompt;
      requests += 1;
      if (requests === 1) {
        return route.fulfill({
          json: {
            status: "needs_clarification",
            sourceOriginalPrompt: prompt,
            mandate: null,
            clarification: "What is your maximum total budget in USD, including shipping and tax?",
          },
        });
      }
      expect(prompt).toContain("Maximum total budget: $600 USD");
      return route.fulfill({
        json: { status: "ready", sourceOriginalPrompt: prompt, mandate: readyMandate },
      });
    });
    await page.goto("/mandates/new");
    const input = page.getByLabel("What should your agent be allowed to buy?");
    const original = "Find the best price for both PlayStation 5 models and buy the cheaper one.";
    await input.fill(original);
    await page.getByRole("button", { name: "Review mandate", exact: true }).click();
    const feedback = page.getByRole("alert", { name: "Add a little more detail to continue" });
    await expect(feedback).toBeVisible();
    await expect(feedback).toBeFocused();
    await expect(feedback).toBeInViewport({ ratio: 1 });
    await expect(feedback).toContainText("maximum total budget in USD");
    await expect(feedback).toContainText("Update your request above");
    await expect(input).toHaveValue(original);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-describedby", /mandate-prompt-feedback/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`clarification-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Edit my request", exact: true }).click();
    await expect(input).toBeFocused();
    await input.fill(`${original} Maximum total budget: $600 USD. Ask before every purchase.`);
    await page.getByRole("button", { name: "Review mandate", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "These are the permissions your agent will receive." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "These are the permissions your agent will receive." }),
    ).toBeFocused();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(requests).toBe(2);
    expect(saves).toBe(0);
  });
}

test("shows loading and a visible service failure, then retries the same valid prompt", async ({
  page,
}, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/api/mandates/parse", async (route) => {
    expect(route.request().postDataJSON().prompt).toBe(budgetPrompt);
    if (++requests === 1) {
      await gate;
      return route.fulfill({
        status: 503,
        json: { error: "The service is temporarily unavailable." },
      });
    }
    return route.fulfill({
      json: { status: "ready", sourceOriginalPrompt: budgetPrompt, mandate: readyMandate },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mandates/new");
  const input = page.getByLabel("What should your agent be allowed to buy?");
  await input.fill(budgetPrompt);
  await page.getByRole("button", { name: "Review mandate", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reading request…", exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("This may take a few moments");
  release();
  const feedback = page.getByRole("alert", { name: "We couldn’t review your request" });
  await expect(feedback).toBeFocused();
  await expect(feedback).toBeInViewport({ ratio: 1 });
  await expect(feedback).toContainText("service is temporarily unavailable");
  await expect(feedback).toContainText("without retyping");
  await expect(input).toHaveValue(budgetPrompt);
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.screenshot({
    path: testInfo.outputPath("service-failure-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "These are the permissions your agent will receive." }),
  ).toBeVisible();
  expect(requests).toBe(2);
});

for (const [status, message] of [
  [400, "Check the product and maximum total budget in USD"],
  [401, "Your session has expired"],
  [429, "Wait a minute"],
] as const) {
  test(`explains a ${status} failure without asking for missing information`, async ({ page }) => {
    await page.route("**/api/mandates/parse", (route) =>
      route.fulfill({ status, json: { error: "Request failed" } }),
    );
    await page.goto("/mandates/new");
    await page.getByLabel("What should your agent be allowed to buy?").fill(budgetPrompt);
    await page.getByRole("button", { name: "Review mandate", exact: true }).click();
    const feedback = page.getByRole("alert", { name: "We couldn’t review your request" });
    await expect(feedback).toBeFocused();
    await expect(feedback).toContainText(message);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  });
}

test("explains a connection failure and keeps the request editable", async ({ page }) => {
  await page.route("**/api/mandates/parse", (route) => route.abort("failed"));
  await page.goto("/mandates/new");
  const input = page.getByLabel("What should your agent be allowed to buy?");
  await input.fill(budgetPrompt);
  await page.getByRole("button", { name: "Review mandate", exact: true }).click();
  const feedback = page.getByRole("alert", { name: "We couldn’t review your request" });
  await expect(feedback).toContainText("Check your internet connection");
  await expect(feedback).toBeFocused();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(budgetPrompt);
});
