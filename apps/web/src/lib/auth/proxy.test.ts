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
});
