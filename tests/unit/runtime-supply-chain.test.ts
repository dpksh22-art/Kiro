import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime supply-chain packaging", () => {
  it("ships runtime commands from production dependencies and audits the full lockfile and final image", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.dependencies.tsx).toBeTruthy();
    expect(pkg.devDependencies.tsx).toBeUndefined();
    expect(pkg.scripts["db:migrate"]).toContain("tsx");
    expect(pkg.scripts.backup).toContain("tsx");
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("COPY --from=production-deps");
    expect(dockerfile).not.toContain("COPY --from=build --chown=nexus:nexus /app/node_modules");
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/- run: npm audit\n/);
    expect(workflow).toContain("docker run --rm nexus-ci:${{ github.sha }} npm audit --omit=dev");
  });
});
