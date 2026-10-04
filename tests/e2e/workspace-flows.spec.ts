import { expect, test, type Page } from "@playwright/test";

const configured =
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  /:4100(?:\/|$)/.test(process.env.MANDATEPAY_E2E_API_URL ?? "") &&
  Boolean(process.env.TEST_DATABASE_URL);
const origin = "http://127.0.0.1:3100";

async function account(page: Page) {
  const suffix = crypto.randomUUID();
  const response = await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
    headers: { origin, "x-forwarded-for": `192.0.2.${150 + test.info().parallelIndex}` },
    data: {
      name: "Workspace flow test",
      email: `workspace-${suffix}@mandatepay.local`,
      password: `Test-${suffix}-password`,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function mandate(page: Page, title: string) {
  const parsed = await page.request.post("/api/mandates/parse", {
    headers: { origin },
    data: { prompt: "Find Sony or Bose headphones under $180. Buy new only. Ask me above $150." },
  });
  expect(parsed.ok()).toBeTruthy();
  const body = await parsed.json();
  const created = await page.request.post("/api/mandates", {
    headers: { origin },
    data: {
      originalPrompt: "Find new headphones under $180.",
      mandate: { ...body.mandate, title },
      requestKey: crypto.randomUUID(),
    },
  });
  expect(created.ok()).toBeTruthy();
  const { mandate: saved } = await created.json();
  expect(
    (
      await page.request.post(`/api/mandates/${saved.id}/activate`, {
        headers: { origin },
        data: { version: saved.version },
      })
    ).ok(),
  ).toBeTruthy();
  return saved.id as string;
}

test.beforeEach(() => test.skip(!configured, "Requires the isolated E2E API and database."));

test("binds discovery to a deliberate mandate and opens the exact approval", async ({ page }) => {
  await account(page);
  await page.goto("/chat");
  const first = await mandate(page, "Travel headphones");
  const second = await mandate(page, "Office headphones");
  await page.goto(`/chat?mandate=${first}`);
  await expect(page.getByRole("combobox", { name: "Mandate", exact: true })).toHaveValue(first);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (await page.getByRole("combobox", { name: "Mandate", exact: true }).boundingBox())!.width,
  ).toBeGreaterThan(240);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: "Browse products", exact: true }).click();
  await expect(page.getByLabel("Shopping permissions")).toHaveValue(first);
  await page.goto("/discover");
  await expect(page.getByLabel("Shopping permissions")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await page.getByLabel("Shopping permissions").selectOption(second);
  await page.getByLabel("Search products").fill("headphones");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const choices = page.getByRole("checkbox", { name: "Compare", exact: true });
  await expect(choices).toHaveCount(3);
  await choices.nth(0).check();
  await choices.nth(1).check();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/products/compare", async (route) => {
    expect(route.request().postDataJSON().mandateId).toBe(second);
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByRole("button", { name: "Compare selected (2)" }).click();
  await expect(choices.nth(0)).toBeDisabled();
  await expect(page.getByLabel("Shopping permissions")).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "Comparison ready." })).toBeVisible();
  await page
    .getByRole("button", { name: /Prepare proposal/ })
    .first()
    .click();
  const review = page.getByRole("link", { name: "Review approval", exact: true });
  await expect(review).toHaveAttribute("href", /\/approvals\?proposal=/);
  const proposalId = new URL((await review.getAttribute("href"))!, origin).searchParams.get(
    "proposal",
  );
  await review.click();
  await expect(page).toHaveURL(new RegExp(`/approvals\\?proposal=${proposalId}`));
  await expect(
    page.getByRole("region").getByRole("button", { name: "Approve proposal", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Back to approval inbox", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review proposal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review proposal", exact: true })).toBeFocused();
});

test("keeps the composer in view, retries with the same key, and scrolls conversation independently", async ({
  page,
}) => {
  await account(page);
  const keys: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/agent/chat", async (route) => {
    keys.push(route.request().postDataJSON().requestKey);
    if (keys.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: "The shopping agent is temporarily unavailable." },
      });
    await gate;
    await route.fulfill({
      json: {
        message: Array.from(
          { length: 60 },
          (_, index) =>
            `Option ${index + 1}: review the purchase and its recorded permission before checkout.`,
        ).join("\n"),
        explanation: null,
        proposals: [],
        refundDraft: null,
        steps: [],
      },
    });
  });
  await page.goto("/chat");
  await expect(page.getByLabel("Message the shopping agent")).toBeEnabled();
  await page.getByLabel("Message the shopping agent").fill("Help me review a previous purchase.");
  await page.getByLabel("Message the shopping agent").press("Control+Enter");
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New brief", exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("log")).toContainText("Option 60:");
  expect(keys[0]).toBe(keys[1]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= window.innerHeight + 1 &&
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const log = page.getByRole("log");
    await expect
      .poll(() =>
        log.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
        ),
      )
      .toBe(true);
    // Let resize observers finish before simulating a separate user scroll.
    await log.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await log.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await log.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    const send = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
    expect(send.y + send.height).toBeLessThanOrEqual(844);
    await page.getByRole("button", { name: "Jump to latest" }).click();
    expect(
      await log.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "New brief", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your shopping brief starts here." }),
  ).toBeVisible();
});

test("locks refund details while the provider outcome is pending", async ({ page }) => {
  await account(page);
  const payment = {
    id: "fixture-payment",
    proposalId: "fixture-proposal",
    status: "COMPLETED",
    amount: 16900,
    currency: "USD",
    paypalOrderId: "fixture-order",
    paypalCaptureId: "fixture-capture",
    capturedAt: "2026-10-03T10:00:00.000Z",
    createdAt: "2026-10-03T10:00:00.000Z",
    product: {
      title: "Fixture headphones",
      brand: "Sony",
      condition: "NEW",
      merchant: "Mandate Demo Store",
    },
    mandate: { title: "Fixture mandate", version: 1 },
    refunds: [],
  };
  await page.route("**/api/orders/fixture-payment", (route) =>
    route.fulfill({ json: { payment } }),
  );
  await page.route("**/api/audit?*", (route) => route.fulfill({ json: { events: [] } }));
  const keys: string[] = [];
  await page.route("**/api/payments/fixture-payment/refund", (route) => {
    keys.push(route.request().postDataJSON().requestKey);
    return route.fulfill({
      json: {
        payment,
        pending: true,
        refund: {
          id: "fixture-refund",
          status: "PENDING",
          amount: 16900,
          currency: "USD",
          paypalRefundId: null,
        },
      },
    });
  });
  await page.goto("/orders/fixture-payment");
  await page.getByLabel("Reason", { exact: true }).fill("Return this purchase.");
  await page.getByRole("button", { name: "Request refund", exact: true }).click();
  await page.getByRole("button", { name: "Confirm refund", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same refund" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Partial refund", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Reason", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same refund" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
});
