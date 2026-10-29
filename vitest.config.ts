import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", ".next/**", "node_modules/**"],
    environment: "node",
    globals: true,
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    sequence: { concurrent: false },
    fileParallelism: false,
    coverage: { reporter: ["text", "json", "html"] },
  },
});
