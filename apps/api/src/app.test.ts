import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("foundation API", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports a healthy foundation service", async () => {
    app = await createApp({ authRuntime: null });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "mandatepay-api",
      stage: "mvp",
    });
  });

  it("does not register domain routes without an authenticated runtime", async () => {
    app = await createApp({ authRuntime: null });

    const response = await app.inject({ method: "GET", url: "/api/mandates" });

    expect(response.statusCode).toBe(404);
  });

  it("fails closed when authentication configuration is unavailable", async () => {
    app = await createApp({ authRuntime: null });

    const auth = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(auth.statusCode).toBe(503);
    expect(auth.json()).toEqual({
      error: "Authentication is temporarily unavailable.",
      code: "AUTH_UNAVAILABLE",
    });

    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "unavailable",
      code: "AUTH_UNAVAILABLE",
    });
  });
});
