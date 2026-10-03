import { defineConfig, devices } from "@playwright/test";
import { loadE2eEnvironment } from "./scripts/e2e-environment.mjs";

const isolated = loadE2eEnvironment();
for (const [key, value] of Object.entries(isolated)) process.env[key] = value;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/e2e-services.mjs",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
