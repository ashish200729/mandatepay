import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildForwardHeaders, isAllowedContentType, proxyToApi } from "./proxy";

describe("auth API proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards cookies and origin while excluding authorization and hop-by-hop headers", () => {
    const request = new Request("http://127.0.0.1:3000/api/me", {
      headers: {
        accept: "application/json",
        authorization: "Bearer must-not-forward",
        cookie: "better-auth.session_token=session",
        host: "127.0.0.1:3000",
        "content-length": "12",
        origin: "http://127.0.0.1:3000",
      },
    });

    const headers = buildForwardHeaders(request);

    expect(headers.get("cookie")).toBe("better-auth.session_token=session");
    expect(headers.get("origin")).toBe("http://127.0.0.1:3000");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
  });

  it("allows JSON and browser form media types only", () => {
    expect(isAllowedContentType("application/json; charset=utf-8")).toBe(true);
    expect(isAllowedContentType("application/x-www-form-urlencoded")).toBe(true);
    expect(isAllowedContentType("multipart/form-data; boundary=abc")).toBe(true);
    expect(isAllowedContentType("text/xml")).toBe(false);
  });

  it("rejects unsupported content types before contacting the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: "<credentials />",
      }),
      { path: ["auth", "sign-in", "email"] },
    );

    expect(response.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when the upstream is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("internal URL and token"));

    const response = await proxyToApi(new Request("http://127.0.0.1:3000/api/me"), {
      path: ["me"],
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("internal URL and token");
  });

  it("lets a slow mandate parse finish beyond the ordinary proxy deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), delay);
        return controller.signal;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_target, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            setTimeout(() => resolve(Response.json({ status: "ready" })), 12_000);
          }),
      );
      const response = proxyToApi(
        new Request("http://127.0.0.1:3000/api/mandates/parse", { method: "POST" }),
        {
          path: ["mandates", "parse"],
        },
      );
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await response).status).toBe(200);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("hides upstream 5xx bodies behind a generic 503", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("database password and internal stack", { status: 500 }),
    );

    const response = await proxyToApi(new Request("http://127.0.0.1:3000/api/me"), {
      path: ["me"],
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database password");
  });

  it("allows a multi-round chat to finish after the ordinary ten-second deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), delay);
        return controller.signal;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_target, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            setTimeout(() => resolve(Response.json({ message: "Options ready" })), 45_000);
          }),
      );
      const response = proxyToApi(
        new Request("http://127.0.0.1:3000/api/agent/chat", { method: "POST" }),
        { path: ["agent", "chat"] },
      );
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await response).status).toBe(200);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns a distinct chat timeout when the API does not finish", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), delay);
        return controller.signal;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_target, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
      const response = proxyToApi(
        new Request("http://127.0.0.1:3000/api/agent/chat", { method: "POST" }),
        { path: ["agent", "chat"] },
      );
      await vi.advanceTimersByTimeAsync(130_000);
      const result = await response;
      expect(result.status).toBe(504);
      expect(await result.json()).toMatchObject({
        code: "SHOPPING_TIMEOUT",
        error: expect.stringContaining("Retry the same request"),
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    [504, "SHOPPING_TIMEOUT", "took too long"],
    [503, "SHOPPING_AI_UNAVAILABLE", "AI service is unavailable"],
    [502, "SHOPPING_AI_RESPONSE_INVALID", "couldn’t read"],
    [503, "SHOPPING_TOOLS_UNAVAILABLE", "Product search or comparison"],
    [500, "private unknown code", "temporarily unavailable"],
  ])(
    "retains safe chat failure guidance for %s %s and hides upstream details",
    async (status, code, message) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(
          { code, error: "private provider payload and secret token" },
          { status: status as number },
        ),
      );
      const response = await proxyToApi(
        new Request("http://127.0.0.1:3000/api/agent/chat", { method: "POST" }),
        { path: ["agent", "chat"] },
      );
      const body = await response.text();
      expect(body).toContain(message);
      expect(body).not.toContain("private");
      expect(response.status).toBe(status === 500 ? 503 : status);
    },
  );

  it("forwards successful auth responses and set-cookie without content-length", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "12",
          "set-cookie": "better-auth.session_token=session; Path=/; HttpOnly",
        },
      }),
    );

    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/auth/sign-in/email?source=e2e", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "password1234" }),
      }),
      { path: ["auth", "sign-in", "email"] },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=session");
    expect(await response.json()).toEqual({ ok: true });

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toContain("/api/auth/sign-in/email?source=e2e");
    expect((init?.headers as Headers).get("content-type")).toContain("application/json");
  });

  it.each([
    ["POST", "request-password-reset", ""],
    ["POST", "send-verification-email", ""],
    ["POST", "reset-password", ""],
    ["GET", "verify-email", "?token=fake-token&callbackURL=%2Fverify-email"],
    ["GET", "reset-password/fake-token", "?callbackURL=%2Freset-password"],
  ])("forwards %s recovery path %s and preserves callback query", async (method, path, query) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "/reset-password?token=fake-token" },
      }),
    );
    const response = await proxyToApi(
      new Request(`http://127.0.0.1:3000/api/auth/${path}${query}`, { method }),
      { path: ["auth", ...path.split("/")] },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/reset-password?token=fake-token");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/api/auth/${path}${query}`);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
