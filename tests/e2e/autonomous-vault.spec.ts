import { expect, test, type Page } from "@playwright/test";
import { captureChat, chatResult } from "./chat-capture";

// Saved PayPal (Vault) consent -> autonomy on -> chat ALLOW -> paid without a redirect.
// Runs only against the isolated loopback stack with the simulated PayPal provider.
const isolatedApiUrl = process.env.MANDATEPAY_E2E_API_URL ?? process.env.API_URL ?? "";
const configured =
  process.env.MANDATEPAY_E2E_MANDATES === "1" &&
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  process.env.MANDATEPAY_E2E_MOCK_PARSER === "1" &&
  /:4100(?:\/|$)/.test(isolatedApiUrl) &&
  Boolean(process.env.TEST_DATABASE_URL);
const appOrigin = "http://127.0.0.1:3100";
// Requires the matching scenario in scripts/e2e-parser-provider.mjs (demo-headphones-139).
const AUTOPAY_PROMPT = "Buy the $139 new Sony headphones with my saved PayPal.";

async function createAllowMandate(page: Page, title: string) {
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
      // The Demo Catalog merchant is new to this account; keep the $139 purchase an ALLOW.
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

test.describe("autonomous purchasing with a saved PayPal method", () => {
  test.beforeEach(() => {
    test.skip(
      !configured,
      "Requires the isolated PostgreSQL/API:4100 stack and explicit fake AI/PayPal providers.",
    );
  });

  test("saves PayPal with consent, pays an ALLOW proposal automatically and removes it", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = crypto.randomUUID();
    await page.goto("/signup?returnTo=%2Fsettings");
    await page.getByLabel("Name").fill("Autonomous Vault E2E");
    await page.getByLabel("Email").fill(`vault-${suffix}@mandatepay.local`);
    await page.getByLabel("Password").fill(`Test-${suffix}-password`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/settings$/);

    const card = page.getByRole("region", { name: "Save PayPal for autonomous purchases" });
    await expect(card.getByText("No PayPal method is saved.")).toBeVisible();
    const save = card.getByRole("button", { name: "Save PayPal with PayPal approval" });
    await expect(save).toBeDisabled();

    // The simulated PayPal approval page immediately returns the buyer to MandatePay.
    await page.route("https://www.sandbox.paypal.com/agreements/approve?*", async (route) => {
      const token = new URL(route.request().url()).searchParams.get("approval_session_id");
      const response = await page.request.get(`${isolatedApiUrl}/__e2e/paypal/return-url/${token}`);
      expect(response.ok()).toBeTruthy();
      const { url } = await response.json();
      expect(url).toBe(`${appOrigin}/settings?vault=return`);
      await route.fulfill({ status: 302, headers: { location: url }, body: "" });
    });
    await card
      .getByRole("checkbox", { name: /I allow MandatePay to charge my saved PayPal/u })
      .check();
    await save.click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(card.getByText(/Saved PayPal · s\*\*\*@example\.com/u)).toBeVisible();
    const method = await (await page.request.get("/api/payment-methods/paypal")).json();
    expect(method.paymentMethod.status).toBe("ACTIVE");
    expect(JSON.stringify(method)).not.toMatch(/VTOK/u);

    // The switch is server-confirmed: it flips only after the setting is saved.
    const autonomy = page.getByRole("switch", { name: "Automatic purchase permissions" });
    await autonomy.click();
    await expect(autonomy).toBeChecked();
    await expect(page.getByText("Automatic permissions are on", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("settings-saved-paypal.png"),
      fullPage: true,
    });

    const mandateId = await createAllowMandate(page, "Saved PayPal headphones");
    await page.goto("/chat");
    await page.getByRole("combobox", { name: "Mandate", exact: true }).selectOption(mandateId);
    const chats = await captureChat(page);
    await page.getByLabel("Message the shopping agent").fill(AUTOPAY_PROMPT);
    const chat = chats.next();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const completed = await chat;
    expect(completed.status).toBe(200);
    const body = chatResult(completed) as Record<string, any>;
    expect(body.proposals).toHaveLength(1);
    const [proposal] = body.proposals;
    expect(proposal.decision.decision).toBe("ALLOW");
    expect(proposal.autopay).toMatchObject({ outcome: "PAID", paymentStatus: "COMPLETED" });
    expect(proposal.proposal.status).toBe("COMPLETED");

    const proposalCard = page.getByRole("article").filter({ hasText: "$139.00" });
    await expect(
      proposalCard.getByText("Paid automatically with your saved PayPal", { exact: true }),
    ).toBeVisible();
    await expect(
      proposalCard.getByRole("link", { name: "Continue to Sandbox checkout" }),
    ).toHaveCount(0);
    await proposalCard.getByRole("link", { name: /View receipt/u }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${proposal.autopay.paymentId}$`));
    await expect(page.getByText("Server confirmed capture", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Paid automatically with your saved PayPal — no PayPal redirect was needed."),
    ).toBeVisible();
    const receipt = await (
      await page.request.get(`/api/orders/${proposal.autopay.paymentId}`)
    ).json();
    expect(receipt.payment).toMatchObject({
      status: "COMPLETED",
      amount: 13_900,
      paymentSource: "vault",
    });
    expect(receipt.payment.paypalCaptureId).toMatch(/^CAP/u);

    // A repeated autopay request returns the same receipt and never charges again.
    const retry = await page.request.post(`/api/proposals/${proposal.proposal.id}/autopay`, {
      headers: { origin: appOrigin },
      data: {},
    });
    expect(retry.ok()).toBeTruthy();
    const retried = await retry.json();
    expect(retried.autopay.outcome).toBe("PAID");
    expect(retried.autopay.payment.id).toBe(proposal.autopay.paymentId);

    await page.goto("/settings");
    await card.getByRole("button", { name: "Remove saved PayPal" }).click();
    await card.getByRole("button", { name: "Yes, remove saved PayPal" }).click();
    await expect(card.getByText("Your saved PayPal was removed.")).toBeVisible();
    await expect(card.getByText("No PayPal method is saved.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
