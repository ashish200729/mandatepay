import { test, expect } from "@playwright/test";

test.afterAll(async ({ request }) => {
  await request.post("http://127.0.0.1:4121/__admin_fixture/cleanup");
});

test("admin identity, BFF, expiry and responsive session flows", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = "http://127.0.0.1:4121";
  const fixture = (await (await request.get(`${api}/__admin_fixture`)).json()) as {
    adminEmail: string;
    normalEmail: string;
    password: string;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?state=expired$/u);
  await expect(page.getByRole("status")).toContainText("session expired");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByLabel("Email", { exact: true }).fill(fixture.normalEmail);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in to admin" }).click();
  await expect(page.locator("#sign-in-error")).toContainText("Unable to sign in with this account");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("desktop-rejected.png"), fullPage: true });

  await page.getByLabel("Email", { exact: true }).fill(fixture.adminEmail);
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in to admin" }).click();
  await expect(page.locator("#sign-in-error")).toContainText("Unable to sign in");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in to admin" }).click();
  await expect(page.getByRole("heading", { name: "Your admin session" })).toBeVisible();
  const me = await page.request.get("/api/admin/me");
  expect(me.status()).toBe(200);
  expect(me.headers()["cache-control"]).toContain("no-store");
  expect(await me.text()).not.toMatch(/"token"|password|sessionId/u);
  const audit = await page.request.get("/api/admin/audit?action=ADMIN_LOGIN_SUCCEEDED&limit=2");
  expect(audit.status()).toBe(200);
  const auditData = await audit.json();
  const signedInUserId = (await me.json()).data.user.id;
  expect(
    auditData.data.some((event: { actorUserId: string }) => event.actorUserId === signedInUserId),
  ).toBe(true);
  expect(audit.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await audit.text()).not.toContain(fixture.password);
  const auditDetail = await page.request.get(`/api/admin/audit/${auditData.data[0].id}`);
  expect(auditDetail.status()).toBe(200);
  expect((await auditDetail.json()).data.id).toBe(auditData.data[0].id);
  const oldCookies = await page.context().cookies();
  expect(oldCookies.some((cookie) => cookie.httpOnly && cookie.sameSite === "Lax")).toBe(true);
  expect((await page.request.post("/api/admin/session", { data: {} })).status()).toBe(403);
  expect((await page.request.get("/api/admin/payments")).status()).toBe(404);
  expect(
    (
      await page.request.post("/api/admin/session", {
        headers: { origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByLabel("Confirm your password").fill(fixture.password);
  await page.getByRole("button", { name: "Confirm password", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Password confirmed");
  const stale = await browser.newContext();
  await stale.addCookies(oldCookies);
  expect((await stale.request.get("http://127.0.0.1:3121/api/admin/me")).status()).toBe(401);
  await stale.close();
  await page.screenshot({ path: testInfo.outputPath("desktop-session.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to admin" })).toBeVisible();
  expect((await page.request.get("/api/admin/me")).status()).toBe(401);
  expect(errors).toEqual([]);

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  await phone.goto("http://127.0.0.1:3121/login");
  await phone.screenshot({ path: testInfo.outputPath("mobile-login.png"), fullPage: true });
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const submit = phone.getByRole("button", { name: "Sign in to admin" });
  expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await phone.getByLabel("Email", { exact: true }).fill(fixture.adminEmail);
  await phone.getByLabel("Password", { exact: true }).fill(fixture.password);
  await submit.click();
  await expect(phone.getByRole("heading", { name: "Your admin session" })).toBeVisible();
  await request.post(`${api}/__admin_fixture/state`, { data: { action: "inactive" } });
  await phone.reload();
  await expect(phone).toHaveURL(/\/access-denied$/u);
  await expect(phone.getByRole("heading", { name: "Admin access required" })).toBeVisible();
  await phone.screenshot({ path: testInfo.outputPath("mobile-denied.png"), fullPage: true });
  await request.post(`${api}/__admin_fixture/state`, { data: { action: "active" } });
  await request.post(`${api}/__admin_fixture/state`, { data: { action: "idle" } });
  await phone.goto("http://127.0.0.1:3121/");
  await expect(phone).toHaveURL(/\/login\?state=expired$/u);
  await expect(phone.getByRole("status")).toContainText("session expired");
  await phone.screenshot({ path: testInfo.outputPath("mobile-expired.png"), fullPage: true });
  await mobile.close();
});

test("sign-in loading and service error states remain usable", async ({ page }) => {
  await page.goto("/login");
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/admin/session", async (route) => {
    await response;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Administration is temporarily unavailable. Try again shortly." },
      }),
    });
  });
  await page.getByLabel("Email", { exact: true }).fill("fixture@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in to admin" }).click();
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Checking your credentials");
  release();
  await expect(page.locator("#sign-in-error")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Sign in to admin" })).toBeEnabled();
});
