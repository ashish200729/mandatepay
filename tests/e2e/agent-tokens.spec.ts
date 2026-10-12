import { expect, test, type Page } from "@playwright/test";

// Settings -> create an MCP agent token -> call the agent gateway directly on the API host
// with that token -> propose the $139 Demo Catalog headphones -> AgentGuard decision ->
// revoke in Settings -> the same token is refused. Runs only against the isolated loopback stack.
const isolatedApiUrl = process.env.MANDATEPAY_E2E_API_URL ?? process.env.API_URL ?? "";
const configured =
  process.env.MANDATEPAY_E2E_MANDATES === "1" &&
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  process.env.MANDATEPAY_E2E_MOCK_PARSER === "1" &&
  /:4100(?:\/|$)/.test(isolatedApiUrl) &&
  Boolean(process.env.TEST_DATABASE_URL);
const appOrigin = "http://127.0.0.1:3100";
const gateway = `${isolatedApiUrl}/api/agent-gateway/v1`;

async function createMandate(page: Page, title: string) {
  const originalPrompt =
    "Find Sony or Bose headphones under $180. Buy new only. Ask me above $150.";
  const headers = { origin: appOrigin };
  const parsed = await page.request.post("/api/mandates/parse", {
    headers,
    data: { prompt: originalPrompt },
  });
  expect(parsed.ok()).toBeTruthy();
  const parsedBody = await parsed.json();
  expect(parsedBody.status).toBe("ready");
  const created = await page.request.post("/api/mandates", {
    headers,
    data: {
      originalPrompt,
      mandate: { ...parsedBody.mandate, title, newMerchantRequiresApproval: false },
      requestKey: crypto.randomUUID(),
    },
  });
  expect(created.ok()).toBeTruthy();
  const { mandate } = await created.json();
  const activated = await page.request.post(`/api/mandates/${mandate.id}/activate`, {
    headers,
    data: { version: mandate.version },
  });
  expect(activated.ok()).toBeTruthy();
  return mandate.id as string;
}

test.describe("MCP agent connections", () => {
  test.beforeEach(() => {
    test.skip(
      !configured,
      "Requires the isolated PostgreSQL/API:4100 stack and the explicit fake AI provider.",
    );
  });

  test("creates a token, lets an external agent propose through AgentGuard, then revokes it", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = crypto.randomUUID();
    await page.goto("/signup?returnTo=%2Fsettings");
    await page.getByLabel("Name").fill("Agent Token E2E");
    await page.getByLabel("Email").fill(`agent-token-${suffix}@mandatepay.local`);
    await page.getByLabel("Password").fill(`Test-${suffix}-password`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    const mandateId = await createMandate(page, "Agent gateway headphones");

    const card = page.getByRole("region", { name: "Connect an AI agent (MCP)" });
    await expect(card.getByText("No agents are connected yet.")).toBeVisible();
    await card.getByLabel("Connection name").fill("E2E Agent");
    await expect(card.getByRole("checkbox", { name: /Propose purchases/u })).toBeChecked();
    await expect(
      card.getByRole("checkbox", { name: /Autopay with saved PayPal/u }),
    ).not.toBeChecked();
    await card.getByLabel("Expires after").selectOption("7");
    await card.getByRole("button", { name: "Create agent token" }).click();

    const tokenField = card.getByLabel("Agent token");
    await expect(tokenField).toHaveValue(/^mp_agent_[A-Za-z0-9_-]{43}$/u);
    const token = await tokenField.inputValue();
    await card.getByText("Claude Desktop config (claude_desktop_config.json)").click();
    await expect(card.locator("pre")).toContainText('"MANDATEPAY_AGENT_TOKEN"');
    await expect(card.locator("pre")).toContainText(isolatedApiUrl);
    await expect(card.getByText(/E2E Agent/u).first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("settings-agent-token.png"),
      fullPage: true,
    });

    // The token never appears again once the one-time panel is dismissed.
    const listed = await page.request.get("/api/agent-tokens");
    expect(await listed.text()).not.toContain(token);

    const authorization = { authorization: `Bearer ${token}` };
    const mandates = await page.request.get(`${gateway}/mandates`, { headers: authorization });
    expect(mandates.status()).toBe(200);
    expect((await mandates.json()).mandates.map((mandate: { id: string }) => mandate.id)).toContain(
      mandateId,
    );

    const search = await page.request.post(`${gateway}/products/search`, {
      headers: authorization,
      data: { mandateId, query: "Sony headphones" },
    });
    expect(search.status()).toBe(200);
    const found = await search.json();
    expect(
      found.products.some(
        (product: { productId: string; priceMinor: number }) =>
          product.productId === "demo-headphones-139" && product.priceMinor === 13_900,
      ),
    ).toBe(true);

    const proposed = await page.request.post(`${gateway}/proposals`, {
      headers: authorization,
      data: { mandateId, productId: "demo-headphones-139", source: "demo", quantity: 1 },
    });
    expect(proposed.status()).toBe(201);
    const body = await proposed.json();
    expect(body.proposal).toMatchObject({ totalMinor: 13_900, currency: "USD" });
    // Automatic permissions are off for a new account, so AgentGuard asks the human.
    expect(body.decision.decision).toBe("REQUIRE_APPROVAL");
    expect(body.decision.explanation.headline).toBeTruthy();
    expect(body.nextStep).toMatchObject({
      action: "HUMAN_APPROVAL_REQUIRED",
      url: `${appOrigin}/approvals`,
    });

    // The agent has no approval route; only the signed-in human can approve.
    const approve = await page.request.post(`${gateway}/proposals/${body.proposal.id}/approve`, {
      headers: authorization,
      data: {},
    });
    expect(approve.status()).toBe(404);

    await page.goto("/settings");
    await card.getByRole("button", { name: "Revoke E2E Agent" }).click();
    await card.getByRole("button", { name: "Yes, revoke E2E Agent" }).click();
    await expect(card.getByText("· Revoked")).toBeVisible();

    // page.request also carries this browser's session cookie: the gateway still refuses.
    const refused = await page.request.get(`${gateway}/mandates`, { headers: authorization });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).code).toBe("AGENT_TOKEN_INVALID");

    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
