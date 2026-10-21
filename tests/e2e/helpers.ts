import { expect, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "Niveshaay@Dev2026";
export const USERS = {
  admin: "admin@niveshaay.local",
  creator: "creator@niveshaay.local",
  approver: "approver@niveshaay.local",
  viewer: "viewer@niveshaay.local",
} as const;

export async function login(page: Page, who: keyof typeof USERS) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("#email", USERS[who]);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL("/"), page.click("button[type=submit]")]);
}

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();
}
