import { describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("foundation environment", () => {
  it("provides validated runtime configuration", () => {
    expect(env.HOST).toBe(process.env.HOST ?? "127.0.0.1");
    expect(env.PORT).toBe(Number(process.env.PORT ?? 4000));
    expect(env.WEB_ORIGIN).toBe(process.env.WEB_ORIGIN ?? "http://localhost:3000");
    expect(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).toContain(env.LOG_LEVEL);
  });
});
