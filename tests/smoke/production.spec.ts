import { expect, test } from "@playwright/test";

test("production entrypoint migrates and becomes ready", async ({ request, page }) => {
  const readiness = await request.get("/api/health/ready");
  expect(readiness.status()).toBe(200);
  await expect(readiness.json()).resolves.toMatchObject({ status: "ready", schema: "0002_security_and_usage.sql", storage: "writable", encryption: "available" });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Models think. Agents coordinate. You stay in control." })).toBeVisible();
});
