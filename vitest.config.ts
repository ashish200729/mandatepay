import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "packages/database/tests/integration/**",
    ],
    setupFiles: ["./vitest.setup.ts"],
    reporters: ["default"],
  },
});
