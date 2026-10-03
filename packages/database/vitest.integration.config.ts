import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const testUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests.");
}
const databaseName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//u, ""));
if (!/_test$/u.test(databaseName) || (databaseUrl && testUrl === databaseUrl)) {
  throw new Error("TEST_DATABASE_URL must target an isolated database ending in _test.");
}

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
