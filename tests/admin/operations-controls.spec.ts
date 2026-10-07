import { test, expect, type Page } from "@playwright/test";

const reason = "Investigating fixture account access.";

async function confirmHighRisk(page: Page, title: string, actionLabel: string, targetId: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByLabel("Target confirmation").fill(targetId);
  await dialog.getByRole("button", { name: "Review action" }).click();
  await dialog.getByRole("button", { name: actionLabel, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Action completed" })).toBeVisible();
}

test("admin can intervene in user access without rewriting provider or policy truth", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = (await (await request.get("http://127.0.0.1:4121/__admin_fixture")).json()) as {
    normalEmail: string;
    originalPrompt: string;
    ownerUserId: string;
    mandateId: string;
    proposedProposalId: string;
  };
  expect((await page.request.post("http://127.0.0.1:4121/__admin_fixture/session")).ok()).toBe(
    true,
  );

  await page.goto(`/users/${fixture.ownerUserId}`);
  await expect(page.getByRole("heading", { name: `User ${fixture.ownerUserId}` })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Add a note" }).click();
  const notes = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add note" }) });
  await notes.getByLabel("Reason").fill(reason);
  await notes.getByLabel("Note").fill("Follow up with the account owner after the investigation.");
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(
    page.getByText("Follow up with the account owner after the investigation."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Disable autonomy" }).click();
  const autonomy = page.getByRole("dialog", { name: "Disable autonomous purchasing" });
  await autonomy.getByLabel("Reason").fill(reason);
  await autonomy.getByRole("button", { name: "Disable autonomy", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Action completed" })).toBeVisible();
  await expect(page.getByText("Autonomous purchasing").locator("..")).toContainText("Off");
  await expect(page.locator("body")).not.toContainText(fixture.originalPrompt);

  await page.goto(`/proposals/${fixture.proposedProposalId}`);
  await expect(
    page.getByRole("heading", { name: `Proposal ${fixture.proposedProposalId}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Re-evaluate with AgentGuard" }).click();
  const reeval = page.getByRole("dialog", { name: "Re-evaluate proposal" });
  await reeval.getByLabel("Reason").fill(reason);
  await reeval.getByRole("button", { name: "Re-evaluate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Action completed" })).toBeVisible();

  await page.goto(`/mandates/${fixture.mandateId}`);
  await expect(page.getByRole("heading", { name: `Mandate ${fixture.mandateId}` })).toBeVisible();
  await page.getByRole("button", { name: "Pause mandate" }).click();
  await confirmHighRisk(page, "Pause mandate", "Pause mandate", fixture.mandateId);
  await expect(page.getByText("paused", { exact: false }).first()).toBeVisible();

  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Admin audit" })).toBeVisible();
  await expect(page.locator("body")).toContainText("ADMIN_NOTE_ADDED");
  await expect(page.locator("body")).toContainText("ADMIN_AUTONOMY_DISABLED");
  await expect(page.locator("body")).toContainText("ADMIN_MANDATE_PAUSED");
  await expect(page.locator("body")).toContainText("ADMIN_PROPOSAL_RE_EVALUATED");
  await expect(page.locator("body")).not.toContainText(fixture.originalPrompt);

  await page.goto(`/users/${fixture.ownerUserId}`);
  await page.getByRole("button", { name: "Disable account" }).click();
  await confirmHighRisk(page, "Disable account", "Disable account", fixture.ownerUserId);
  await expect(page.getByText("disabled", { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
