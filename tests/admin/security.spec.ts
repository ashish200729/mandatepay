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
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.goto("/session");
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
  expect((await page.request.get("/api/admin/payments")).status()).toBe(200);
  expect((await page.request.post("/api/admin/payments", { data: {} })).status()).toBe(405);
  expect(
    (
      await page.request.post("/api/admin/session", {
        headers: { origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "Confirm password", exact: true }).click();
  const passwordDialog = page.getByRole("dialog", { name: "Confirm your password", exact: true });
  await expect(passwordDialog.getByLabel("Confirm your password")).toBeFocused();
  await passwordDialog.getByLabel("Confirm your password").fill(fixture.password);
  await passwordDialog.getByRole("button", { name: "Confirm password", exact: true }).click();
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
  await expect(phone.getByRole("heading", { name: "Operations overview" })).toBeVisible();
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

test("foundation tables restore URL filters, cursor pages and server sorting", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  await page.goto("/ui-fixtures?limit=2");
  await expect(page.getByRole("heading", { name: "UI fixtures", exact: true })).toBeVisible();
  await expect(page.getByText("Test", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sample records" })).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/cursor=2/u);
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/u);
  await page.getByLabel("Result", { exact: true }).selectOption("FAILURE");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/status=FAILURE/u);
  await expect(page.getByRole("table").getByText("failure", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: /Name.*sort ascending/u }).click();
  await expect(page).toHaveURL(/sort=name/u);
  await expect(page.getByRole("columnheader", { name: /Name/u })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await page.getByLabel("Search sample records").fill("Record 04");
  await page.getByLabel("From date").fill("2026-10-04");
  await page.getByLabel("Through date").fill("2026-10-04");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/q=Record\+04/u);
  expect(new URL(page.url()).searchParams.get("to")).toBe("2026-10-05T00:00:00.000Z");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel("Search sample records")).toHaveValue("Record 04");
  await expect(page.getByLabel("Through date")).toHaveValue("2026-10-04");
  await page.getByRole("link", { name: "View record fixture-4", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sample record fixture-4" })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Search sample records")).toHaveValue("Record 04");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/ui-fixtures$/u);
  await page.getByRole("button", { name: "Show loading" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Loading sample records" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show empty" }).click();
  await expect(page.getByRole("heading", { name: "No records" })).toBeVisible();
  await page.getByRole("button", { name: "Show error" }).click();
  await expect(page.getByRole("alert", { name: "Could not load records" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("table", { name: "Sample records" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic audit timeline" })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("fixture-secret-must-not-render");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("desktop-foundation.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("foundation dialogs trap focus, validate reasons and require fresh typed review", async ({
  page,
}, testInfo) => {
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  await page.goto("/ui-fixtures");
  const simpleTrigger = page.getByRole("button", { name: "Open confirmation", exact: true });
  await simpleTrigger.click();
  const simple = page.getByRole("dialog", { name: "Confirm sample action", exact: true });
  await expect(simple.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(simple.getByRole("button", { name: "Run sample action" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(simple).not.toBeVisible();
  await expect(simpleTrigger).toBeFocused();
  await simpleTrigger.click();
  await simple.getByRole("button", { name: "Run sample action" }).click();
  await expect(simple.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(simple).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Action completed" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss Action completed" }).click();
  await page.getByRole("button", { name: "Open reason dialog" }).click();
  const reason = page.getByRole("dialog", { name: "Reason for sample action" });
  await expect(reason.getByLabel("Reason", { exact: true })).toBeFocused();
  await expect(reason.getByRole("button", { name: "Run sample action" })).toBeDisabled();
  await reason.getByLabel("Reason", { exact: true }).fill("token=fixture-unsafe");
  await reason.getByRole("button", { name: "Run sample action" }).click();
  await expect(reason.getByRole("alert")).toContainText("without credentials");
  await expect(reason.getByRole("alert")).toBeFocused();
  await reason.getByLabel("Reason", { exact: true }).fill("Investigating sample ticket.");
  await reason.getByRole("button", { name: "Run sample action" }).click();
  await expect(reason).not.toBeVisible();
  await page.getByRole("button", { name: "Dismiss Action completed" }).click();
  await page.getByRole("button", { name: "Open sensitive action" }).click();
  const danger = page.getByRole("dialog", { name: "Review sensitive sample action" });
  await danger.getByLabel("Reason", { exact: true }).fill("Review the synthetic target.");
  await danger.getByLabel("Target confirmation", { exact: true }).fill("fixture-2");
  await expect(danger.getByRole("button", { name: "Review action" })).toBeDisabled();
  await danger.getByLabel("Target confirmation", { exact: true }).fill("fixture-1");
  await expect(danger.getByRole("button", { name: "Review action" })).toBeDisabled();
  const me = await (await page.request.get("/api/admin/me")).json();
  // UI response simulations only; real reauth/session rotation is verified above.
  let reauthCount = 0;
  await page.route("**/api/admin/reauth", async (route) => {
    reauthCount++;
    if (reauthCount === 1)
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ADMIN_SIGN_IN_REJECTED" } }),
      });
    else
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(me),
      });
  });
  await danger.getByRole("button", { name: "Confirm password", exact: true }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm your password", exact: true });
  await reauth.getByLabel("Confirm your password").fill("invalid-fixture-password");
  await reauth.getByRole("button", { name: "Confirm password" }).click();
  await expect(reauth.getByRole("alert")).toContainText("Password confirmation failed");
  await expect(reauth.getByLabel("Confirm your password")).toHaveValue("");
  await reauth.getByLabel("Confirm your password").fill("simulated-fixture-password");
  await reauth.getByRole("button", { name: "Confirm password" }).click();
  await expect(reauth).not.toBeVisible();
  await expect(danger.getByRole("button", { name: "Review action" })).toBeEnabled();
  await danger.getByRole("button", { name: "Review action" }).click();
  await expect(danger).toContainText("Final review");
  await page.screenshot({
    path: testInfo.outputPath("desktop-sensitive-review.png"),
    fullPage: false,
  });
  await danger.getByRole("button", { name: "Run sample action" }).click();
  await expect(danger).not.toBeVisible();
  const submissions = JSON.parse(
    (await page.getByTestId("sample-submissions").textContent()) ?? "[]",
  );
  expect(submissions).toHaveLength(3);
  expect(submissions[2]).toMatchObject({
    reason: "Review the synthetic target.",
    confirmation: "fixture-1",
  });
  expect(submissions[2].requestKey).toMatch(/^[0-9a-f-]{36}$/u);
  await page.getByLabel("Simulated outcome").selectOption("pending");
  await simpleTrigger.click();
  await simple.getByRole("button", { name: "Run sample action" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Action pending" })).toContainText(
    "not yet confirmed",
  );
  await page.getByLabel("Simulated outcome").selectOption("error");
  await simpleTrigger.click();
  await simple.getByRole("button", { name: "Run sample action" }).click();
  await expect(simple.getByRole("alert")).toContainText("could not be confirmed");
  expect(await simple.textContent()).not.toContain("fixture-provider-secret");
  await simple.getByRole("button", { name: "Run sample action" }).click();
  await expect(simple.getByRole("alert")).toBeVisible();
  const attempts = JSON.parse((await page.getByTestId("sample-submissions").textContent()) ?? "[]");
  expect(attempts.at(-1).requestKey).toBe(attempts.at(-2).requestKey);
  await simple.getByRole("button", { name: "Cancel" }).click();
  await simpleTrigger.click();
  await simple.getByRole("button", { name: "Run sample action" }).click();
  await expect(simple.getByRole("alert")).toBeVisible();
  const reopened = JSON.parse((await page.getByTestId("sample-submissions").textContent()) ?? "[]");
  expect(reopened.at(-1).requestKey).toBe(attempts.at(-1).requestKey);
});

test("foundation tablet and mobile navigation keep full records and keyboard access", async ({
  page,
}, testInfo) => {
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const menu = page.getByRole("button", {
      name: "Open administration menu",
      includeHidden: true,
    });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const drawer = page.getByRole("dialog", { name: "Administration", exact: true });
    await expect(drawer.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(menu).toBeFocused();
    await menu.click();
    await drawer.getByRole("link", { name: "My Session", exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await menu.click();
    await page.mouse.click(viewport.width - 5, 200);
    await expect(drawer).not.toBeVisible();
    await page.goto("/ui-fixtures?limit=2");
    await expect(page.getByRole("table")).not.toBeVisible();
    await expect(page.getByRole("region", { name: "Sample records", exact: true })).toContainText(
      "Created · UTC",
    );
    await expect(page.getByRole("link", { name: /View record fixture-/u })).toHaveCount(2);
    await page.getByRole("button", { name: "Sort by Name", exact: true }).click();
    await expect(page).toHaveURL(/sort=name/u);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Open reason dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Reason for sample action" });
    expect((await dialog.boundingBox())!.width).toBeLessThan(viewport.width);
    await expect(dialog.getByLabel("Reason", { exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(
      (await page.getByRole("button", { name: "Open reason dialog" }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.width}-foundation.png`),
      fullPage: true,
    });
  }
});
