import { expect, test } from "@playwright/test";
import { expectToast, login } from "./helpers";

test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const categoryName = `E2E Category ${stamp}`;
const campaignName = `E2E Campaign ${stamp}`;
let campaignUrl = "";

test("creator creates a category and bulk-assigns clients from the directory", async ({ page }) => {
  await login(page, "creator");
  await page.goto("/categories");
  await page.getByRole("button", { name: "New category" }).click();
  await page.fill("#cat-name", categoryName);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(categoryName);

  await page.goto("/clients?q=Aditya");
  await page.getByRole("checkbox", { name: "Select page" }).check();
  await page.getByRole("button", { name: "Add to categories" }).click();
  await page.getByRole("dialog").getByRole("combobox").click();
  await page.getByRole("option", { name: categoryName }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add memberships" }).click();
  await expectToast(page, /Added \d+ membership/);
});

test("creator builds a WhatsApp campaign through the wizard and requests approval", async ({ page }) => {
  await login(page, "creator");
  await page.goto("/campaigns/new");
  await page.fill("#c-name", campaignName);
  await page.getByRole("button", { name: "Continue" }).click();

  // Audience: an existing category with authorised templates.
  await page.getByText("Event Invitees", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // Channels
  await page.getByRole("button", { name: /WhatsApp only/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // Templates — default authorised template pre-selected
  await expect(page.getByText("Investor meet invitation")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  // Schedule
  await page.getByRole("button", { name: "Continue" }).click();
  // Review
  await expect(page.getByText("Eligible recipients").first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  // Submit
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.waitForURL(/\/campaigns\/[a-z0-9]+$/);
  campaignUrl = page.url();
  await expect(page.getByText("Pending approval").first()).toBeVisible();
  // Maker-checker: the creator sees no approve control.
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
});

test("approver must re-type the message count; approval freezes and executes in mock mode", async ({ page }) => {
  await login(page, "approver");
  await page.goto(campaignUrl);
  const label = await page.locator("label[for=approve-count] .font-mono").innerText();
  const approve = page.getByRole("button", { name: "Approve & freeze audience" });
  await page.fill("#approve-count", "999999");
  await expect(approve).toBeDisabled();
  await page.fill("#approve-count", label.trim());
  await approve.click();
  await expectToast(page, /Approved/);
  await expect(page.getByText(/Audience frozen/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("Simulated execution")).toBeVisible();
});
