import { randomUUID } from "node:crypto";
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
  await expect(page.getByLabel("Research mode")).toHaveValue("-1");
  await page.getByLabel("Source 1").fill("https://example.com/");
  await page.getByRole("button", { name: "Add complementary source" }).click();
  await page.getByLabel("Source 2").fill("https://example.org/");
  await page.getByRole("button", { name: "Run research" }).click();
  const report = page.locator("summary").filter({ hasText: "Verify retrieval and citation provenance" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await report.click();
  await expect(page.getByText("evidence only", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Example Domain/ }).first()).toHaveAttribute("href", "https://example.com/");
  await page.getByText("Stored evidence packet", { exact: true }).click();
  await expect(page.getByText(/Source: https:\/\/example.com\//)).toBeVisible();
  await expect(page.getByText(/Source: https:\/\/example.org\//)).toBeVisible();
});

test("owner uploads an artifact and manages explicit trusted memory", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/artifacts");
  await page.getByLabel("File").setInputFiles({ name: "artifact.txt", mimeType: "text/plain", buffer: Buffer.from("artifact browser check") });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText("artifact.txt")).toBeVisible();
  const download = await page.request.get(await page.getByRole("link", { name: "Download" }).getAttribute("href") as string);
  expect(download.status()).toBe(200);
  expect((await download.body()).toString()).toBe("artifact browser check");

  await page.goto("/settings");
  await page.getByLabel("Content").fill("Keep browser lifecycle tests honest.");
  await page.getByRole("button", { name: "Add memory" }).click();
  await expect(page.getByText(/instruction: Keep browser lifecycle tests honest\./)).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Content").fill("Keep lifecycle tests honest.");
  await page.getByRole("button", { name: "Update memory" }).click();
  await expect(page.getByText(/instruction: Keep lifecycle tests honest\./)).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await expect(page.getByText("No trusted project memory")).toBeVisible();

  const submittedKeys: string[] = [];
  await page.evaluate(() => localStorage.setItem("nexus-account-deletion-idempotency-key", "11111111-1111-4111-8111-111111111111"));
  await page.route("**/api/v1/account/delete", async (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    expect(body).toEqual(expect.objectContaining({ password, confirmation: "DELETE MY NEXUS ACCOUNT" }));
    expect(body).not.toHaveProperty("userId");
    submittedKeys.push(body.idempotencyKey ?? "");
    if (submittedKeys.length === 1) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Previous owner key.", code: "stale_completed_idempotency_key" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "mock-job", state: "completed", retryable: false }) });
  });
  await expect(page.getByText(/cannot revoke provider keys or GitHub tokens remotely/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download JSON export" })).toBeVisible();
  const deleteButton = page.getByRole("button", { name: "Permanently delete account" });
  await expect(deleteButton).toBeDisabled();
  await page.getByLabel("Current password").fill(password);
  await page.getByLabel(/Type DELETE MY NEXUS ACCOUNT/).fill("DELETE MY ACCOUNT");
  await expect(deleteButton).toBeDisabled();
  await page.getByLabel(/Type DELETE MY NEXUS ACCOUNT/).fill("DELETE MY NEXUS ACCOUNT");
  await deleteButton.click();
  await expect(page).toHaveURL(/\/goodbye$/);
  await expect(page.getByRole("heading", { name: "Your local NEXUS account is gone." })).toBeVisible();
  expect(submittedKeys).toHaveLength(2);
  expect(submittedKeys[0]).toBe("11111111-1111-4111-8111-111111111111");
  expect(submittedKeys[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(submittedKeys[1]).not.toBe(submittedKeys[0]);
});

test("unauthenticated API and pages remain protected", async ({ request, page }) => {
  const response = await request.get("/api/v1/models");
  expect(response.status()).toBe(401);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login$/);
});

test("budget API enforces owned scopes and owner-only deletion", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  const projectsResponse = await page.request.get("/api/v1/projects");
  const projects = (await projectsResponse.json() as { projects: Array<{ id: string }> }).projects;
  const projectId = projects[0]!.id;
  const created = await page.request.post("/api/v1/budgets", { data: { kind: "resource", scope: "project", projectId, unit: "model_calls", period: "daily", hardLimit: 3 } });
  expect(created.status()).toBe(201);
  const policyId = (await created.json() as { id: string }).id;
  const listed = await page.request.get("/api/v1/budgets");
  expect((await listed.json() as { policies: Array<{ id: string }> }).policies).toEqual(expect.arrayContaining([expect.objectContaining({ id: policyId })]));
  const foreignProject = await page.request.post("/api/v1/budgets", { data: { kind: "resource", scope: "project", projectId: randomUUID(), unit: "model_calls", period: "daily", hardLimit: 3 } });
  expect(foreignProject.status()).toBe(404);
  const foreignProvider = await page.request.post("/api/v1/budgets", { data: { kind: "resource", scope: "provider", provider: "unowned-provider", unit: "model_calls", period: "daily", hardLimit: 3 } });
  expect(foreignProvider.status()).toBe(404);
  const foreignDelete = await page.request.delete("/api/v1/budgets", { data: { id: randomUUID(), kind: "resource" } });
  expect(foreignDelete.status()).toBe(404);
  const removed = await page.request.delete("/api/v1/budgets", { data: { id: policyId, kind: "resource" } });
  expect(removed.status()).toBe(200);
});
