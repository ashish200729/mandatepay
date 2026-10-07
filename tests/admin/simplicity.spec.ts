import { expect, test } from "@playwright/test";

test("advanced filters stay optional and preserve the view, export and date precision", async ({
  page,
  request,
}, testInfo) => {
  const api = "http://127.0.0.1:4121";
  const fixture = await (await request.get(api + "/__admin_fixture")).json();
  expect((await page.request.post(api + "/__admin_fixture/session")).ok()).toBe(true);
  await page.goto("/refunds");
  const toggle = page.getByRole("button", { name: /^Filters/u });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Owner user ID", { exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Status", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Refunds", exact: true })).toBeVisible();
  await toggle.click();
  await page.getByLabel("Owner user ID", { exact: true }).fill(fixture.ownerUserId);
  await page.getByLabel("From date").fill("2026-10-01");
  await page.getByLabel("Through date").fill("2026-10-07");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page).toHaveURL(/userId=/u);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Clear Owner user ID filter" })).toBeVisible();
  const before = new URL(page.url()).searchParams;
  await page.getByLabel("Status", { exact: true }).selectOption("COMPLETED");
  await expect(page).toHaveURL(/status=COMPLETED/u);
  const after = new URL(page.url()).searchParams;
  expect(after.get("userId")).toBe(fixture.ownerUserId);
  expect(after.get("from")).toBe(before.get("from"));
  expect(after.get("to")).toBe(before.get("to"));
  const exported = new URL(
    (await page.getByRole("link", { name: "Export CSV" }).getAttribute("href"))!,
    page.url(),
  );
  expect(exported.searchParams.get("userId")).toBe(fixture.ownerUserId);
  expect(exported.searchParams.get("status")).toBe("COMPLETED");
  await page.getByRole("button", { name: "Clear Dates · UTC filter" }).click();
  await expect(page).not.toHaveURL(/from=|to=/u);
  await page.getByRole("button", { name: "Clear Owner user ID filter" }).click();
  await expect(page).not.toHaveURL(/userId=/u);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page).toHaveURL(/\/refunds$/u);
  await page.goto("/refunds?from=2026-10-01T04%3A20%3A00.000Z&to=2026-10-08T01%3A00%3A00.000Z");
  await page.getByLabel("Status", { exact: true }).selectOption("COMPLETED");
  await expect(page).toHaveURL(/status=COMPLETED/u);
  const precision = new URL(page.url()).searchParams;
  expect(precision.get("from")).toBe("2026-10-01T04:20:00.000Z");
  expect(precision.get("to")).toBe("2026-10-08T01:00:00.000Z");
  await toggle.click();
  await page.getByLabel("Payment ID", { exact: true }).fill(fixture.paymentId);
  await page.getByRole("button", { name: "Close filters" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("REQUESTED");
  await expect(page).toHaveURL(/status=REQUESTED/u);
  expect(new URL(page.url()).searchParams.has("paymentId")).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("applied-filters.png") });
});

test("reporting and diagnostic details remain discoverable", async ({ page }) => {
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  await page.goto("/");
  await expect(page.getByLabel("From date")).not.toBeVisible();
  await page.getByRole("button", { name: "Custom dates", exact: true }).click();
  await page.getByLabel("From date").fill("2026-10-01");
  await page.getByLabel("Through date").fill("2026-10-07");
  await page.getByRole("button", { name: "Apply custom range" }).click();
  await expect(page).toHaveURL(/from=/u);
  await expect(page.getByLabel("Time period")).toHaveValue("custom");
  await page.locator("summary").filter({ hasText: "More metrics" }).click();
  await expect(page.getByRole("heading", { name: "Agent requests" })).toBeVisible();
  await page.goto("/agent?outcome=FAILED&errorClass=TIMEOUT");
  await expect(page.getByLabel("Run outcome")).toHaveValue("FAILED");
  await expect(page.getByLabel("Error category")).toHaveValue("TIMEOUT");
  await page.getByLabel("Run outcome").selectOption("SUCCEEDED");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/outcome=SUCCEEDED/u);
  await expect(page).toHaveURL(/errorClass=TIMEOUT/u);
});

test("admin form focus stays visible without an outer double frame", async ({ page }, testInfo) => {
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/agent");
    await page.waitForLoadState("networkidle");
    await page.bringToFront();
    const select = page.getByLabel("Run outcome");
    await page.keyboard.press("Tab");
    await select.focus();
    await expect(select).toBeFocused();
    await expect
      .poll(() =>
        select.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.outlineColor === style.borderColor && style.outlineColor !== style.color;
        }),
      )
      .toBe(true);
    const focus = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.outlineColor,
        border: style.borderColor,
        offset: parseFloat(style.outlineOffset),
        width: parseFloat(style.outlineWidth),
      };
    });
    expect(focus.offset).toBeLessThanOrEqual(0);
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.color).toBe(focus.border);
    const rgb = focus.color.match(/\d+/g)!.slice(0, 3).map(Number);
    const luminance = rgb
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath(`${width}-select-focus.png`) });
  }
});
