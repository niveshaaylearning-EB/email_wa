import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SCREENS: [string, string | RegExp][] = [
  ["/", /Good (morning|afternoon|evening)/],
  ["/clients", "Client directory"],
  ["/categories", "Categories"],
  ["/templates", "Template library"],
  ["/campaigns", "Campaign Studio"],
  ["/scheduled", "Scheduled campaigns"],
  ["/approvals", "Approval queue"],
  ["/analytics", "Delivery analytics"],
  ["/activity", "Activity logs"],
  ["/integrations", "Integrations"],
  ["/settings", "Settings"],
];

test("every screen renders without client errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "admin");
  for (const [path, heading] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(heading);
  }
  expect(errors).toEqual([]);
});

test("unauthenticated users are redirected to sign in; bad credentials are rejected", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/campaigns");
  await expect(page).toHaveURL(/\/login\?next=%2Fcampaigns/);
  await page.fill("#email", "admin@niveshaay.local");
  await page.fill("#password", "wrong-password");
  await page.click("button[type=submit]");
  await expect(page.getByRole("alert").filter({ hasText: "Invalid email or password" })).toBeVisible();
});

test("development data is clearly labelled", async ({ page }) => {
  await login(page, "admin");
  await expect(page.getByText("Development data — not real activity")).toBeVisible();
  await expect(page.getByText("Safe mode")).toBeVisible();
});
