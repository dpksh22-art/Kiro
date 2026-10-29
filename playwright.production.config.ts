import { defineConfig } from "@playwright/test";

const env = {
  NODE_ENV: "production",
  PORT: "3200",
  BETTER_AUTH_URL: "http://127.0.0.1:3200",
  BETTER_AUTH_SECRET: "production-smoke-secret-at-least-thirty-two-characters",
  NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_DATABASE_PATH: `${process.cwd()}/data/production-smoke.db`,
  NEXUS_BOOTSTRAP_TOKEN: "production-smoke-bootstrap-token",
};

export default defineConfig({
  testDir: "./tests/smoke",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3200" },
  webServer: { command: "npx tsx scripts/prepare-production-smoke.ts && npm run start:production", url: "http://127.0.0.1:3200/api/health/ready", timeout: 120_000, reuseExistingServer: false, env },
});
