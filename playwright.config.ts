import { defineConfig, devices } from "@playwright/test";

const env = {
  NODE_ENV: "test",
  BETTER_AUTH_URL: "http://127.0.0.1:3100",
  BETTER_AUTH_SECRET: "e2e-auth-secret-that-is-at-least-thirty-two-characters",
  NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_DATABASE_PATH: "./data/e2e.db",
  NEXUS_BOOTSTRAP_TOKEN: "e2e-owner-bootstrap-token-very-secret",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "npx tsx scripts/prepare-e2e.ts && npm run dev -- --hostname 127.0.0.1 --port 3100", url: "http://127.0.0.1:3100/api/health/live", timeout: 120_000, reuseExistingServer: false, env },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
