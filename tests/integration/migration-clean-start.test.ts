import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let temporaryRoot: string | undefined;
afterEach(() => { if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true }); temporaryRoot = undefined; });

describe("production clean-start migration", () => {
  it("creates the complete schema without a transient Better Auth mismatch error", () => {
    temporaryRoot = mkdtempSync(resolve(process.cwd(), "data/clean-start-"));
    const execution = spawnSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/migrate.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://127.0.0.1:3999",
        BETTER_AUTH_SECRET: "clean-start-auth-secret-that-is-at-least-32-characters",
        NEXUS_MASTER_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        NEXUS_DATABASE_PATH: resolve(temporaryRoot, "nexus.db"),
        NEXUS_ARTIFACT_ROOT: resolve(temporaryRoot, "artifacts"),
      },
    });
    const output = `${execution.stdout}\n${execution.stderr}`;
    expect(execution.status, output).toBe(0);
    expect(output).toContain("Applied 0010_security_reliability_boundaries.sql");
    expect(output).not.toMatch(/ERROR.*schema|schema.*mismatch/i);
  });
});
