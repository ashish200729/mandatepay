import { expect, test } from "@playwright/test";

test("all admin records and workspaces remain usable at phone, tablet and desktop widths", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = "http://127.0.0.1:4121";
  const fixture = await (await request.get(`${api}/__admin_fixture`)).json();
  expect((await page.request.post(`${api}/__admin_fixture/session`)).ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const speculativeReads: string[] = [];
  page.on("request", (request) => {
    if (request.headers()["next-router-prefetch"]) speculativeReads.push(request.url());
  });
  const records = [
    ["users", fixture.ownerUserId],
    ["mandates", fixture.mandateId],
    ["proposals", fixture.proposalId],
    ["approvals", fixture.approvalId],
    ["orders", fixture.paymentId],
    ["payments", fixture.paymentId],
    ["refunds", fixture.refundId],
    ["webhooks", fixture.webhookId],
  ] as const;
  const audit = await (await page.request.get("/api/admin/audit?limit=1")).json();
  const paths = [
    "/",
    ...records.map(([resource]) => `/${resource}`),
    "/audit",
    "/agent",
    "/system",
    "/settings",
    "/session",
    ...records.map(([resource, id]) => `/${resource}/${id}`),
    `/audit/${audit.data[0].id}`,
  ];
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(
        page.getByText("This record could not be loaded.", { exact: false }),
      ).not.toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}px ${path} should have no document overflow`,
      ).toBe(true);
      if (
        [390, 1440].includes(width) &&
        [
          "/",
          "/users",
          "/refunds",
          `/payments/${fixture.paymentId}`,
          "/settings",
          "/system",
        ].includes(path)
      ) {
        await page.screenshot({
          path: testInfo.outputPath(
            `${width}-${path === "/" ? "overview" : path.split("/")[1]}.png`,
          ),
        });
      }
    }
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/payments/${fixture.paymentId}`);
  await page.getByRole("button", { name: "Copy record ID" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fixture.paymentId);
  await page.goto("/payments/00000000-0000-4000-8000-999999999999");
  await expect(page.getByRole("heading", { name: "Record not found", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to overview" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(speculativeReads).toEqual([]);
});

test("sign-in password visibility, keyboard feedback and small-screen controls work", async ({
  page,
}, testInfo) => {
  await page.goto("/login");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .getByLabel("Email", { exact: true })
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(width < 640 ? 16 : 14);
    await page.screenshot({ path: testInfo.outputPath(`${width}-sign-in.png`) });
  }
  await page.getByLabel("Email", { exact: true }).fill("admin-ui-only@mandatepay.local");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("ui-test-only-password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Administration is temporarily unavailable. Try again shortly." },
      }),
    }),
  );
  await page.getByRole("button", { name: "Sign in to admin" }).click();
  await expect(page.locator("#sign-in-error")).toBeFocused();
  await expect(password).toHaveValue("");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "admin-ui-only@mandatepay.local",
  );
  await expect(page.getByRole("button", { name: "Sign in to admin" })).toBeEnabled();
});

test("configuration reports a failed fresh-session read before opening an action", async ({
  page,
}) => {
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );
  await page.goto("/settings");
  await page.route("**/api/admin/me", (route) => route.abort("failed"));
  await page.getByRole("button", { name: /Turn Maintenance mode/u }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not verify your admin session" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Turn Maintenance mode/u })).toBeEnabled();
});
