import { rmSync } from "node:fs";
import { resolve } from "node:path";

export default async function setup() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "test-auth-secret-that-is-at-least-thirty-two-characters",
    NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    NEXUS_DATABASE_PATH: "./data/vitest.db",
    NEXUS_ARTIFACT_ROOT: "./data/vitest-artifacts",
    NEXUS_ARTIFACT_QUOTA_BYTES: "104857600",
  });
  rmSync(resolve(process.cwd(), "data/vitest.db"), { force: true });
  rmSync(resolve(process.cwd(), "data/vitest.db-wal"), { force: true });
  rmSync(resolve(process.cwd(), "data/vitest.db-shm"), { force: true });
  rmSync(resolve(process.cwd(), "data/vitest-artifacts"), { force: true, recursive: true });
  const { migrate } = await import("../scripts/migrate");
  await migrate();
}
