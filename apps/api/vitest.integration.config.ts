import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { DATABASE_ENV_KEYS, loadWorkspaceEnvironment } from "../../scripts/environment.mjs";

loadWorkspaceEnvironment({
  workspaceDirectory: fileURLToPath(new URL("./", import.meta.url)),
  mode: "test",
  keys: DATABASE_ENV_KEYS,
});
if (
  !process.env.TEST_DATABASE_URL ||
  !decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).pathname).endsWith("_test") ||
  process.env.TEST_DATABASE_URL === process.env.DATABASE_URL
) {
  throw new Error(
    "Auth integration requires a dedicated TEST_DATABASE_URL whose database name ends in _test.",
  );
}
process.env.AUTH_SECRET ||= "integration-test-only-session-secret-32-characters";
process.env.NODE_ENV = "test";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
