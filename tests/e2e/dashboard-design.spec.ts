import { expect, test, type Page } from "@playwright/test";

const configured =
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  /:4100(?:\/|$)/.test(process.env.MANDATEPAY_E2E_API_URL ?? "") &&
  Boolean(process.env.TEST_DATABASE_URL);
const timestamp = "2026-10-03T09:30:00.000Z";
const transactions = [
  {
    id: "design-captured",
    paymentId: "design-payment",
    createdAt: timestamp,
    capturedAt: timestamp,
    activityAt: timestamp,
    product: {
      title: "Sony WH-1000XM5 Noise Cancelling Headphones",
      brand: "Sony",
      condition: "NEW",
    },
    merchant: "Mandate Demo Store",
    category: "headphones",
    amountMinor: 16900,
    currency: "USD",
    mandate: { title: "Headphones for the home office", version: 1 },
    decision: "ALLOW",
    approvalType: "HUMAN_APPROVED",
    paypalStatus: "PARTIALLY_REFUNDED",
  },
  {
    id: "design-approval",
    paymentId: null,
    createdAt: timestamp,
    capturedAt: null,
    activityAt: timestamp,
    product: { title: "Bose QuietComfort Wireless Headphones", brand: "Bose", condition: "NEW" },
    merchant: "Mandate Demo Store",
    category: "headphones",
    amountMinor: 17900,
    currency: "USD",
    mandate: { title: "Headphones for the home office", version: 1 },
    decision: "REQUIRE_APPROVAL",
    approvalType: "PENDING_APPROVAL",
    paypalStatus: null,
  },
  {
    id: "design-blocked",
    paymentId: null,
    createdAt: timestamp,
    capturedAt: null,
    activityAt: timestamp,
    product: {
      title: "Bose QuietComfort Refurbished Headphones",
      brand: "Bose",
      condition: "REFURBISHED",
    },
    merchant: "Mandate Demo Store",
    category: "headphones",
    amountMinor: 12000,
    currency: "USD",
    mandate: { title: "Headphones for the home office", version: 1 },
    decision: "BLOCK",
    approvalType: "BLOCKED",
    paypalStatus: null,
  },
];
const totals = {
  purchases: 1,
  policyAllowed: 1,
  humanApproved: 1,
  blocked: 1,
  spendMinor: 16900,
  refundsMinor: 2000,
  activeMandates: 2,
};
const policyEvent = {
  id: "design-policy",
  proposalId: "design-blocked",
  createdAt: timestamp,
  product: {
    title: transactions[2]!.product.title,
    merchant: "Mandate Demo Store",
    category: "headphones",
  },
  mandate: transactions[2]!.mandate,
  reasonCodes: ["CONDITION_NOT_ALLOWED"],
  rulesSnapshot: {},
};

async function signUp(page: Page) {
  const suffix = crypto.randomUUID();
  // Provision a real isolated session with a distinct fixture client address.
  // Signup UI and BFF forwarding are covered by auth.spec.ts; do not consume
  // their shared browser-client signup rate limit for visual fixtures.
  const response = await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
    headers: {
      origin: "http://127.0.0.1:3100",
      "x-forwarded-for": `192.0.2.${100 + test.info().parallelIndex}`,
    },
    data: {
      name: "Dashboard design review",
      email: `design-${suffix}@mandatepay.local`,
      password: `Test-${suffix}-password`,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.beforeEach(() => test.skip(!configured, "Requires isolated E2E authentication services."));

test("keeps the ledger readable, navigable and complete across desktop and mobile", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.route("**/api/dashboard/summary", (route) => route.fulfill({ json: { totals } }));
  await page.route("**/api/dashboard/transactions?*", (route) =>
    route.fulfill({ json: { transactions, nextCursor: null } }),
  );
  await page.route("**/api/dashboard/policy-events", (route) =>
    route.fulfill({ json: { events: [policyEvent] } }),
  );
  await signUp(page);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.getByLabel("Minimum · USD")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
    const product = page
      .getByRole("link", {
        name: `Open details for ${transactions[0]!.product.title}`,
        exact: true,
      })
      .filter({ visible: true });
    await expect(product).toHaveAttribute("href", "/orders/design-payment");
    if (width >= 1280) {
      for (const name of ["Activity date · UTC", "Product", "Amount", "Decision", "Payment"]) {
        const header = page.getByRole("columnheader", { name, exact: true }).first();
        expect(
          await header.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const grid = element.closest(".ag-root-wrapper")!.getBoundingClientRect();
            return bounds.left >= grid.left && bounds.right <= grid.right;
          }),
        ).toBe(true);
      }
    }
    if (width === 1440)
      await page.screenshot({ path: testInfo.outputPath("dashboard-desktop.png"), fullPage: true });
    if (width === 1280)
      await page.screenshot({ path: testInfo.outputPath("dashboard-1280.png"), fullPage: true });
    if (width === 390) {
      const record = page.getByRole("article").filter({ hasText: transactions[0]!.product.title });
      await expect(record.getByText("Partial refund", { exact: true })).toBeVisible();
      await expect(record.getByText("PARTIALLY REFUNDED", { exact: true })).toBeVisible();
      await expect(
        record.getByText("Headphones for the home office · v1", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("dashboard-mobile.png"), fullPage: true });
      await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
      await expect(page.getByRole("link", { name: "Control center", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Open workspace navigation", exact: true }),
      ).toBeFocused();
      await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toHaveCount(0);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Minimum · USD").fill("150");
  await page.getByLabel("Policy decision").selectOption("REQUIRE_APPROVAL");
  const filterRequest = page.waitForRequest((request) =>
    request.url().includes("minAmountMinor=15000"),
  );
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const params = new URL((await filterRequest).url()).searchParams;
  expect(params.get("decision")).toBe("REQUIRE_APPROVAL");
  await expect(page.getByText("Decision REQUIRE_APPROVAL", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page.getByLabel("Minimum · USD")).toHaveValue("");
  await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
  await page.getByRole("link", { name: "Mandates", exact: true }).click();
  await expect(page).toHaveURL(/\/mandates$/);
  await expect(
    page.getByRole("button", { name: "Open workspace navigation", exact: true }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("shows loading, recoverable errors, and helpful empty states without losing the filters", async ({
  page,
}) => {
  let failed = true;
  let resolveSummary!: () => void;
  const summaryReady = new Promise<void>((resolve) => {
    resolveSummary = resolve;
  });
  await page.route("**/api/dashboard/summary", async (route) => {
    await summaryReady;
    await route.fulfill(
      failed
        ? { status: 503, json: { error: "Analytics is temporarily unavailable." } }
        : { json: { totals: { ...totals, purchases: 0, spendMinor: 0, blocked: 0 } } },
    );
  });
  await page.route("**/api/dashboard/transactions?*", (route) =>
    route.fulfill({ json: { transactions: [], nextCursor: null } }),
  );
  await page.route("**/api/dashboard/policy-events", (route) =>
    route.fulfill({ json: { events: [] } }),
  );
  await signUp(page);
  await expect(page.getByRole("status")).toContainText("Loading verified control-center data");
  resolveSummary();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Analytics is temporarily unavailable.",
  );
  failed = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your activity starts here." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your first mandate" })).toBeVisible();
  await page.getByLabel("Minimum · USD").fill("invalid");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Minimum · USD")).toHaveValue("invalid");
  await page.getByLabel("Minimum · USD").fill("999");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No transactions match these filters." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your activity starts here." })).toBeVisible();
});
