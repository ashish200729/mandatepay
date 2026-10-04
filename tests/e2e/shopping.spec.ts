import { expect, test, type Page } from "@playwright/test";
import { captureWorkspace } from "./workspace-capture";

const isolatedApiUrl = process.env.MANDATEPAY_E2E_API_URL ?? process.env.API_URL ?? "";
const configured =
  process.env.MANDATEPAY_E2E_MANDATES === "1" &&
  process.env.MANDATEPAY_E2E_AUTH === "1" &&
  process.env.MANDATEPAY_E2E_MOCK_PARSER === "1" &&
  /:4100(?:\/|$)/.test(isolatedApiUrl) &&
  Boolean(process.env.TEST_DATABASE_URL);

async function createActiveMandate(page: Page, title: string) {
  const originalPrompt =
    "Find Sony or Bose headphones under $180. Buy new only. Ask me above $150.";
  const headers = { origin: "http://127.0.0.1:3100" };
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
      mandate: { ...parsedBody.mandate, title },
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

async function sendMessage(page: Page, message: string) {
  await page.getByLabel("Message the shopping agent").fill(message);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agent/chat") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const completed = await response;
  expect(completed.ok()).toBeTruthy();
  return completed.json();
}

async function askDashboard(page: Page, query: string) {
  await page.getByPlaceholder("Show blocked transactions this week").fill(query);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/dashboard/query") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const completed = await response;
  expect(completed.ok()).toBeTruthy();
  return completed.json();
}

test.describe("conversational shopping and read-only dashboard", () => {
  test.beforeEach(() => {
    test.skip(
      !configured,
      "Requires the isolated PostgreSQL/API:4100 stack and explicit fake AI/PayPal providers.",
    );
  });

  test("selects a mandate, shows genuine policy decisions, filters and opens unpaid details", async ({
    page,
  }, testInfo) => {
    const suffix = crypto.randomUUID();
    await page.goto("/signup?returnTo=%2Fchat");
    await page.getByLabel("Name").fill("Conversational Shopping E2E");
    await page.getByLabel("Email").fill(`shopping-${suffix}@mandatepay.local`);
    await page.getByLabel("Password").fill(`Test-${suffix}-password`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/chat$/);

    await createActiveMandate(page, "First headphones mandate");
    const selectedMandateId = await createActiveMandate(page, "Selected headphones mandate");
    await page.reload();
    await page
      .getByRole("combobox", { name: "Mandate", exact: true })
      .selectOption(selectedMandateId);
    const requested = await sendMessage(
      page,
      "Compare Sony headphones and prepare the $169 new pair for review.",
    );
    expect(requested.proposals).toHaveLength(1);
    const proposed = requested.proposals[0];
    expect(proposed.proposal.mandateId).toBe(selectedMandateId);
    expect(proposed.proposal.total).toBe(16900);
    expect(proposed.proposal.status).toBe("AWAITING_APPROVAL");
    expect(proposed.decision.decision).toBe("REQUIRE_APPROVAL");
    expect(requested.steps.map((step: { name: string }) => step.name)).toEqual([
      "get_active_mandates",
      "search_products",
      "compare_products",
      "create_purchase_proposal",
    ]);
    const proposalCard = page.getByRole("article").filter({ hasText: "$169.00" });
    await expect(
      proposalCard.getByText("AgentGuard: REQUIRE APPROVAL", { exact: true }),
    ).toBeVisible();
    await expect(
      proposalCard.getByText("Selected headphones mandate · v1", { exact: true }),
    ).toBeVisible();
    await expect(proposalCard.getByRole("link", { name: "Review approval" })).toBeVisible();
    await expect(
      proposalCard.getByRole("link", { name: "Continue to Sandbox checkout" }),
    ).toHaveCount(0);
    await page.getByText("Show server steps", { exact: true }).click();
    await expect(page.getByText("compare_products", { exact: true })).toBeVisible();
    await captureWorkspace(page, testInfo, "chat");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("chat-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    const blocked = await sendMessage(page, "Prepare the refurbished Bose headphones for review.");
    // Search enforces NEW-only permissions before a proposal can be prepared.
    expect(blocked.proposals).toHaveLength(0);
    expect(blocked.steps.map((step: { name: string }) => step.name)).toEqual([
      "get_active_mandates",
      "search_products",
    ]);
    const blockedCard = page
      .getByRole("article")
      .filter({ hasText: "Bose QuietComfort Refurbished Headphones" });
    await expect(blockedCard).toHaveCount(0);
    expect((await (await page.request.get("/api/orders")).json()).orders).toHaveLength(0);

    // A caller supplying a known controlled SKU directly must still be blocked
    // by AgentGuard. Keep that policy and dashboard coverage separate from chat filtering.
    const headers = { origin: "http://127.0.0.1:3100" };
    const attempted = await page.request.post("/api/proposals", {
      headers,
      data: {
        mandateId: selectedMandateId,
        source: "demo",
        productId: "demo-headphones-refurbished",
        quantity: 1,
        requestKey: crypto.randomUUID(),
      },
    });
    expect(attempted.ok()).toBeTruthy();
    const { proposal: attemptedProposal } = await attempted.json();
    const evaluated = await page.request.post(`/api/proposals/${attemptedProposal.id}/evaluate`, {
      headers,
      data: {},
    });
    expect(evaluated.ok()).toBeTruthy();
    const blockedProposal = await evaluated.json();
    expect(blockedProposal.proposal.status).toBe("BLOCKED");
    expect(blockedProposal.decision.reasonCodes).toContain("CONDITION_NOT_ALLOWED");

    await page.getByRole("link", { name: "Control center", exact: true }).click();
    const table = await askDashboard(page, "Show headphone transactions above $150 as a table.");
    expect(table.filters.minimumAmountMinor).toBe(15000);
    expect(table.filters.minimumAmountOperator).toBe("gt");
    expect(table.transactions.map((row: { id: string }) => row.id)).toEqual([proposed.proposal.id]);
    await expect(page.getByPlaceholder("Min amount USD")).toHaveValue("150.00");
    await expect(page.getByText("> $150.00", { exact: true })).toBeVisible();
    await expect(page.getByText(/The query requested the transaction table only/)).toBeVisible();
    const details = page.getByRole("link", {
      name: "Open details for Sony WH-1000XM5 Noise Cancelling Headphones",
      exact: true,
    });
    await expect(details).toHaveAttribute("href", `/proposals/${proposed.proposal.id}`);
    await details.click();
    await expect(page).toHaveURL(new RegExp(`/proposals/${proposed.proposal.id}$`));
    await expect(page.getByRole("heading", { name: "Policy decision", exact: true })).toBeVisible();
    await expect(page.getByText("REQUIRE APPROVAL", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Control center", exact: true }).click();
    const decisions = await askDashboard(
      page,
      "Show blocked headphone transactions this week by decision.",
    );
    expect(decisions.filters.decision).toBe("BLOCK");
    expect(decisions.filters.since).toMatch(/T00:00:00\.000Z$/);
    expect(decisions.transactions.map((row: { id: string }) => row.id)).toEqual([
      blockedProposal.proposal.id,
    ]);
    await expect(page.getByText("Decision BLOCK", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Decision breakdown", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Captured spend by category", exact: true }),
    ).toHaveCount(0);
    const category = await askDashboard(page, "Show headphone spending by category.");
    expect(category.transactions).toHaveLength(2);
    await expect(
      page.getByRole("heading", { name: "Captured spend by category", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Decision breakdown", exact: true }),
    ).toHaveCount(0);
    const beforeClarification = category.transactions.map((row: { id: string }) => row.id);
    const clarified = await askDashboard(page, "Delete all transactions.");
    expect(clarified.status).toBe("needs_clarification");
    await expect(
      page.getByText("Please ask a read-only question about your transactions.", { exact: true }),
    ).toBeVisible();
    expect(
      (await (await page.request.get("/api/dashboard/transactions")).json()).transactions.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(beforeClarification);
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(page.getByPlaceholder("Min amount USD")).toHaveValue("");
    await expect(page.getByPlaceholder("Show blocked transactions this week")).toHaveValue("");
    await expect(
      page.getByText("Please ask a read-only question about your transactions.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Spend by mandate", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("dashboard-desktop.png"), fullPage: true });
  });
});
