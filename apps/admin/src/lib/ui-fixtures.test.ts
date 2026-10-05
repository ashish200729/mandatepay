import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
import { requireUiFixtures } from "./ui-fixtures";
afterEach(() => vi.unstubAllEnvs());
it("requires explicit test mode and a loopback origin for UI fixture routes", () => {
  vi.stubEnv("ADMIN_UI_FIXTURES", "");
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  vi.stubEnv("ADMIN_ORIGIN", "http://127.0.0.1:3121");
  expect(() => requireUiFixtures()).toThrow();
  vi.stubEnv("ADMIN_UI_FIXTURES", "1");
  expect(() => requireUiFixtures()).not.toThrow();
  vi.stubEnv("ADMIN_ENVIRONMENT", "production");
  expect(() => requireUiFixtures()).toThrow();
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  vi.stubEnv("ADMIN_ORIGIN", "https://admin.example.test");
  expect(() => requireUiFixtures()).toThrow();
});
