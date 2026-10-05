import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/admin",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3121",
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/admin-e2e-services.mjs",
    url: "http://127.0.0.1:3121/login",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
