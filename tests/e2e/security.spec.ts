import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("viewer role is read-only (UI and server-side)", async ({ page }) => {
  await login(page, "viewer");
  await page.goto("/campaigns");
  await expect(page.getByRole("link", { name: "New campaign" })).toHaveCount(0);
  await page.goto("/categories");
  await expect(page.getByRole("button", { name: "New category" })).toHaveCount(0);
  // Server enforces authorisation regardless of UI.
  const res = await page.request.post("/api/v1/categories", { data: { name: "Should not exist", color: "#1E3A5F", priority: 1 }, headers: { "x-ncc-request": "1" } });
  expect(res.status()).toBe(403);
  const audit = await page.request.get("/api/v1/audit");
  expect(audit.status()).toBe(403);
});

test("mutations without the CSRF header or from another origin are rejected", async ({ page }) => {
  await login(page, "admin");
  const noHeader = await page.request.post("/api/v1/categories", { data: { name: "csrf", color: "#1E3A5F", priority: 1 } });
  expect(noHeader.status()).toBe(403);
  const crossOrigin = await page.request.post("/api/v1/categories", { data: { name: "csrf", color: "#1E3A5F", priority: 1 }, headers: { "x-ncc-request": "1", origin: "https://evil.example" } });
  expect(crossOrigin.status()).toBe(403);
});

test("integration secrets are never returned to the browser", async ({ page }) => {
  await login(page, "admin");
  const res = await page.request.get("/api/v1/integrations");
  const body = await res.text();
  expect(res.ok()).toBeTruthy();
  expect(body).not.toMatch(/key_[A-Za-z0-9]{20,}/);
  expect(body).not.toContain("secretsEncrypted");
});

test("webhook endpoint rejects unauthenticated deliveries", async ({ request }) => {
  const res = await request.post("/api/webhooks/doubletick/status", { data: { messageId: "x", status: "DELIVERED" } });
  expect(res.status()).toBe(401);
});
