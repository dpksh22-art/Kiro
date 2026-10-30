import { defineConfig, devices } from "@playwright/test";

const env = {
  NODE_ENV: "production",
  BETTER_AUTH_URL: "http://127.0.0.1:3100",
  BETTER_AUTH_SECRET: "e2e-auth-secret-that-is-at-least-thirty-two-characters",
  NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_BACKUP_SIGNING_KEY: "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_DATABASE_PATH: `${process.cwd()}/data/e2e.db`,
  NEXUS_ARTIFACT_ROOT: `${process.cwd()}/data/e2e-artifacts`,
  NEXUS_BOOTSTRAP_TOKEN: "e2e-owner-bootstrap-token-very-secret",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "npx tsx scripts/prepare-e2e.ts && npx tsx scripts/prepare-standalone-assets.ts && HOSTNAME=127.0.0.1 PORT=3100 node .next/standalone/server.js", url: "http://127.0.0.1:3100/api/health/live", timeout: 120_000, reuseExistingServer: false, env },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
