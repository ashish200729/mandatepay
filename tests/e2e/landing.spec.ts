import { expect, test } from "@playwright/test";

test.describe("anonymous landing page", () => {
  test("loads the premium landing experience with real navigation landmarks", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("MandatePay — AI commerce, on your terms.");
    await expect(
      page.getByRole("heading", { name: "A smarter way to shop. On your terms." }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Explore MandatePay" }),
    ).toBeVisible();
    await expect(
      page.getByRole("main").getByRole("link", { name: "Explore MandatePay" }),
    ).toBeVisible();
    await expect(page.locator('img[src*="mandatepay-meadow"]')).toHaveCount(2);

    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
    await expect(footer.getByRole("navigation", { name: "Footer navigation" })).toBeVisible();
    await expect(footer.getByText("© 2026 MandatePay")).toBeVisible();
  });

  test("preserves keyboard focus visibility and section navigation", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();

    await page.getByRole("link", { name: "AgentGuard", exact: true }).first().click();
    await expect(page).toHaveURL(/#agentguard$/);
    await expect(
      page.getByRole("heading", { name: "From a little request to a clear permission." }),
    ).toBeVisible();
  });

  test("opens and closes FAQ disclosures", async ({ page }) => {
    await page.goto("/#questions");

    const faq = page.locator("details").filter({ hasText: "What is a purchase mandate?" });
    await expect(faq).toBeVisible();
    await expect(faq).not.toHaveAttribute("open", "");

    await faq.locator("summary").click();
    await expect(faq).toHaveAttribute("open", "");
    await expect(
      faq.getByText("A purchase mandate is the permission you give an AI agent", { exact: false }),
    ).toBeVisible();

    await faq.locator("summary").click();
    await expect(faq).not.toHaveAttribute("open", "");
  });

  test("handles mobile menu selection, Escape, outside press, and desktop breakpoint", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const menu = page.locator('details:has(summary[aria-label="Toggle navigation"])');
    const toggle = menu.locator('summary[aria-label="Toggle navigation"]');
    const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });

    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(mobileNav).toBeVisible();

    await toggle.press("Escape");
    await expect(mobileNav).not.toBeVisible();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(mobileNav).toBeVisible();
    await page.mouse.click(16, 320);
    await expect(mobileNav).not.toBeVisible();

    await toggle.click();
    await mobileNav.getByRole("link", { name: "Your control" }).click();
    await expect(page).toHaveURL(/#your-control$/);
    await expect(mobileNav).not.toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(toggle).not.toBeVisible();
  });
});

test("renders the foundation 404 screen with a recovery link", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist");

  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "This page hasn’t been built yet." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to MandatePay" })).toBeVisible();
});
