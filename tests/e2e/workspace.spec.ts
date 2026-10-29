import { expect, test } from "@playwright/test";

const email = "owner@nexus.test";
const password = "Correct-Horse-Battery-Staple-42";

test("owner signs up and protected workspace loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("tab", { name: "Sign up" }).click();
  await page.getByLabel("Name").fill("NEXUS Owner");
  await page.getByLabel("Owner bootstrap token").fill("e2e-owner-bootstrap-token-very-secret");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
  await expect(page.getByText("Connected providers")).toBeVisible();
});

test("owner uses credential-free research and inspects provenance", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /Research Lab/ }).click();
  await page.getByLabel("Research objective").fill("Verify retrieval and citation provenance");
  await page.getByLabel("Source").fill("https://example.com/");
  await page.getByRole("button", { name: "Run research" }).click();
  const report = page.locator("summary").filter({ hasText: "Verify retrieval and citation provenance" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await report.click();
  await expect(page.getByText(/Source: https:\/\/example.com\//)).toBeVisible();
});

test("unauthenticated API and pages remain protected", async ({ request, page }) => {
  const response = await request.get("/api/v1/models");
  expect(response.status()).toBe(401);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login$/);
});
