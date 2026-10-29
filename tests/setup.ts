Object.assign(process.env, {
  NODE_ENV: "test",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-auth-secret-that-is-at-least-thirty-two-characters",
  NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  NEXUS_DATABASE_PATH: "./data/vitest.db",
});
