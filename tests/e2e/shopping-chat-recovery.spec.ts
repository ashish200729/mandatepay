import { expect, test } from "@playwright/test";

const rules = {
  title: "Nike shoes",
  productIntent: "Nike shoes",
  currency: "USD",
  timezone: "UTC",
  allowedBrands: ["Nike"],
  blockedBrands: [],
  allowedCategories: [],
  blockedCategories: [],
  allowedConditions: ["NEW"],
  autoSpendLimit: 0,
  transactionLimit: 10000,
  quantityLimit: 1,
  allowedMerchants: [],
  blockedMerchants: [],
  newMerchantRequiresApproval: true,
};
const success = {
  message: "I checked the available shoe options. No purchase was made.",
  explanation: null,
  proposals: [],
  refundDraft: null,
  steps: [{ name: "search_products", status: "completed" }],
};

for (const width of [1440, 390]) {
  test(`keeps the selected external product and its retailer link at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/agent/chat", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1)
        return route.fulfill({
          json: {
            ...success,
            productContext: "verified-fixture-reference",
            message:
              "- **M AIR PEGASUS 2005** — $49.00 USD at [ka-yo.com](https://ka-yo.com/product/pegasus) (new).",
          },
        });
      if (bodies.length > 2) return route.fulfill({ json: success });
      expect(bodies[1]?.productContext).toBe("verified-fixture-reference");
      return route.fulfill({
        json: {
          ...success,
          productContext: "verified-fixture-reference",
          message:
            "You selected **M AIR PEGASUS 2005** — $49.00 USD at [ka-yo.com](https://ka-yo.com/product/pegasus).\n\nMandatePay can’t buy external retailer products yet. No order or payment has been created.",
          steps: [{ name: "check_checkout_availability", status: "completed" }],
        },
      });
    });
    await page.goto("/chat");
    const input = page.getByRole("textbox", { name: "Message the shopping agent" });
    await input.fill("tell me the shoes or sneakers from this budget");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("link", { name: "ka-yo.com" })).toHaveAttribute(
      "href",
      "https://ka-yo.com/product/pegasus",
    );
    await input.fill("M AIR PEGASUS 2005 — $49.00 USD at ka-yo.com (new). get me this");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("can’t buy external retailer products yet");
    await expect(page.getByRole("log").getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: `test-results/chat-selection-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "New brief" }).click();
    await input.fill("Show shoes");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]?.productContext).toBeUndefined();
  });
}

test("clears an expired selection and restores the request for a fresh search", async ({
  page,
}) => {
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/agent/chat", (route) => {
    bodies.push(route.request().postDataJSON());
    requests++;
    if (requests === 1)
      return route.fulfill({ json: { ...success, productContext: "expired-fixture-reference" } });
    if (requests === 2)
      return route.fulfill({
        status: 409,
        json: {
          code: "SHOPPING_SELECTION_EXPIRED",
          error: "Your previous product list expired. Search again to choose a current product.",
        },
      });
    return route.fulfill({ json: success });
  });
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "Message the shopping agent" });
  await input.fill("Show shoes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(success.message);
  await input.fill("get me this");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log").getByRole("alert")).toContainText("Search again");
  await expect(input).toHaveValue("get me this");
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]?.productContext).toBeUndefined();
});

test("does not reuse a product reference after changing mandates", async ({ page }) => {
  await page.route("**/api/mandates", (route) =>
    route.fulfill({
      json: {
        mandates: ["fixture-mandate", "second-mandate"].map((id) => ({
          id,
          title: id === "fixture-mandate" ? "Nike shoes" : "Other Nike shoes",
          originalPrompt: "Find Nike shoes under $100",
          status: "ACTIVE",
          version: 1,
          rules,
          startsAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        })),
      },
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/agent/chat", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...success, productContext: "first-mandate-reference" } });
  });
  await page.goto("/chat");
  const mandate = page.getByRole("combobox", { name: "Mandate", exact: true });
  await mandate.selectOption("fixture-mandate");
  const input = page.getByRole("textbox", { name: "Message the shopping agent" });
  await input.fill("Show shoes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(success.message);
  await mandate.selectOption("second-mandate");
  await input.fill("Show shoes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]?.mandateId).toBe("second-mandate");
  expect(bodies[1]?.productContext).toBeUndefined();
});

test.beforeEach(async ({ page }) => {
  const suffix = crypto.randomUUID();
  const response = await page.request.post("http://127.0.0.1:4100/api/auth/sign-up/email", {
    headers: {
      origin: "http://127.0.0.1:3100",
      "x-forwarded-for": `192.0.2.${230 + test.info().parallelIndex}`,
    },
    data: {
      name: "Chat recovery test",
      email: `chat-recovery-${suffix}@mandatepay.local`,
      password: `Test-${suffix}-password`,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.route("**/api/mandates", (route) =>
    route.fulfill({
      json: {
        mandates: [
          {
            id: "fixture-mandate",
            title: "Nike shoes",
            originalPrompt: "Find Nike shoes under $100 USD. Ask before purchasing.",
            status: "ACTIVE",
            version: 1,
            rules,
            startsAt: new Date(Date.now() - 60000).toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      },
    }),
  );
});

for (const width of [1440, 390]) {
  test(`recovers a chat timeout with the exact same request at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const bodies: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/agent/chat", async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        await gate;
        return route.fulfill({
          status: 504,
          json: {
            code: "SHOPPING_TIMEOUT",
            error:
              "The shopping assistant took too long to respond. Retry the same request in a moment.",
          },
        });
      }
      return route.fulfill({ json: success });
    });
    await page.goto("/chat");
    await expect(page.getByRole("combobox", { name: "Mandate", exact: true })).toHaveValue(
      "fixture-mandate",
    );
    const message = "What different varieties and quality of Nike shoes do you have?";
    await page.getByLabel("Message the shopping agent").fill(message);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("Finding the next step");
    release();
    const feedback = page.getByRole("main").getByRole("alert");
    await expect(feedback).toContainText("took too long");
    await expect(feedback).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath(`chat-timeout-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Retry same request", exact: true }).click();
    await expect(page.getByRole("log")).toContainText(success.message);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("log").getByText(message)).toHaveCount(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("shows a distinct AI service failure with an available retry", async ({ page }) => {
  await page.route("**/api/agent/chat", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "SHOPPING_AI_UNAVAILABLE",
        error:
          "The shopping assistant’s AI service is unavailable. Retry the same request shortly.",
      },
    }),
  );
  await page.goto("/chat");
  await page.getByLabel("Message the shopping agent").fill("Show available shoes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "AI service is unavailable",
  );
  await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toBeEnabled();
});

for (const width of [1440, 390, 320]) {
  test(`shows a formatted answer immediately at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/agent/chat", (route) =>
      route.fulfill({
        json: {
          ...success,
          message:
            "Shopping request completed. Review the prepared recommendations and policy decisions.",
          explanation: {
            paymentAuthoritative: false,
            text: "Your maximum is **$100.00 USD**. Approval is required before every purchase.\n\n- **Nike Air Max** — $66.99 USD.\n- Nike Pegasus — $49.00 USD.\n\n| Shoe | Listed price |\n| --- | --- |\n| Nike Air Max | $66.99 |\n| Nike Pegasus | $49.00 |\n\nShipping and tax must fit your maximum.",
          },
        },
      }),
    );
    await page.goto("/chat");
    await page.getByLabel("Message the shopping agent").fill("which shoes comes in my budget");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const thread = page.getByRole("log");
    await expect(thread).toContainText("Your maximum is $100.00 USD");
    await expect(thread.locator("strong").filter({ hasText: "$100.00 USD" })).toBeVisible();
    await expect(thread.getByRole("table")).toBeVisible();
    await expect(thread.getByRole("columnheader", { name: "Listed price" })).toBeVisible();
    await expect(thread).not.toContainText("Shopping request completed");
    await expect(thread).not.toContainText("**");
    await expect(thread.getByText("Agent explanation", { exact: true })).toHaveCount(0);
    const serverSteps = thread.locator("summary").filter({ hasText: "Show server steps" });
    await serverSteps.focus();
    await page.keyboard.press("Enter");
    await expect(thread.getByText("search_products", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`chat-answer-${width}.png`),
      fullPage: true,
    });
  });
}

test("keeps provider markup inert and blocks unsafe links and images", async ({ page }) => {
  await page.route("**/api/agent/chat", (route) =>
    route.fulfill({
      json: {
        ...success,
        message:
          'Your maximum is **$100.00 USD**.\n\n<script>window.chatInjected = true</script>\n\n<img src="x" onerror="window.chatInjected = true">\n\n[Unsafe](javascript:alert(1)) ![Tracking](https://tracking.example.test/image.png)\n\n[Retailer](https://retailer.example.test/shoes)',
      },
    }),
  );
  await page.goto("/chat");
  await page.getByLabel("Message the shopping agent").fill("show products");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const thread = page.getByRole("log");
  await expect(thread).toContainText("Your maximum is $100.00 USD");
  await expect(thread.locator("script, img")).toHaveCount(0);
  await expect(thread.getByRole("link", { name: "Unsafe" })).toHaveCount(0);
  await expect(thread.getByRole("link", { name: "Retailer" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  expect(
    await page.evaluate(() => (window as unknown as { chatInjected?: boolean }).chatInjected),
  ).toBeUndefined();
});

test("shows a no-match answer without hiding or losing the saved budget", async ({ page }) => {
  await page.route("**/api/agent/chat", (route) =>
    route.fulfill({
      json: {
        ...success,
        message:
          "Your maximum total budget is **$100.00 USD**. Your approval is required before every purchase.\n\nI couldn’t find products matching this search. Try a broader product description.",
      },
    }),
  );
  await page.goto("/chat");
  await page.getByLabel("Message the shopping agent").fill("compare options within my budget");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("couldn’t find products matching");
  await expect(page.getByRole("log").locator("strong")).toContainText("$100.00 USD");
});
