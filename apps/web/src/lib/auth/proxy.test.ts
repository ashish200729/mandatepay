import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildForwardHeaders,
  clientIpFrom,
  isAllowedContentType,
  proxyToApi,
  relayEventStream,
} from "./proxy";

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

  it("forwards the first X-Forwarded-For hop with the internal proxy secret", () => {
    const secret = "fixture-internal-proxy-secret-0123456789";
    const request = new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      headers: {
        "x-forwarded-for": "203.0.113.9, 10.0.0.2",
        // Caller-supplied internal headers must never be relayed.
        "x-mandatepay-client-ip": "198.51.100.66",
        "x-mandatepay-proxy-secret": "caller-guess",
      },
    });

    const headers = buildForwardHeaders(request, secret);

    expect(headers.get("x-mandatepay-client-ip")).toBe("203.0.113.9");
    expect(headers.get("x-mandatepay-proxy-secret")).toBe(secret);
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("omits the client address without a secret or a valid forwarded hop", () => {
    const secret = "fixture-internal-proxy-secret-0123456789";
    const spoofed = new Request("http://127.0.0.1:3000/api/me", {
      headers: {
        "x-mandatepay-client-ip": "198.51.100.66",
        "x-mandatepay-proxy-secret": "caller-guess",
      },
    });
    for (const headers of [
      buildForwardHeaders(spoofed, secret),
      buildForwardHeaders(
        new Request("http://127.0.0.1:3000/api/me", {
          headers: { "x-forwarded-for": "not-an-address, 10.0.0.2" },
        }),
        secret,
      ),
      buildForwardHeaders(
        new Request("http://127.0.0.1:3000/api/me", {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
        undefined,
      ),
    ]) {
      expect(headers.get("x-mandatepay-client-ip")).toBeNull();
      expect(headers.get("x-mandatepay-proxy-secret")).toBeNull();
    }
    expect(
      clientIpFrom(
        new Request("http://127.0.0.1:3000/api/me", {
          headers: { "x-forwarded-for": " 2001:db8::1 , 10.0.0.2" },
        }),
      ),
    ).toBe("2001:db8::1");
  });

  it("sends the configured proxy secret and client address upstream", async () => {
    vi.stubEnv("INTERNAL_PROXY_SECRET", "fixture-internal-proxy-secret-0123456789");
    try {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      await proxyToApi(
        new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: "{}",
        }),
        { path: ["auth", "sign-in", "email"] },
      );
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-mandatepay-client-ip")).toBe("203.0.113.9");
      expect(headers.get("x-mandatepay-proxy-secret")).toBe(
        "fixture-internal-proxy-secret-0123456789",
      );
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("explains a missing AI configuration without relaying upstream text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { code: "AI_NOT_CONFIGURED", error: "private provider payload" },
        { status: 503 },
      ),
    );

    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/mandates/parse", { method: "POST" }),
      { path: ["mandates", "parse"] },
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: "AI_NOT_CONFIGURED" });
    expect(body.error).toContain("AI service is not configured");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it.each([
    ["paypal", "orders"],
    ["paypal", "orders", "payment-1", "capture"],
    ["payments", "payment-1", "refund"],
  ])("allows slow financial operation %j to finish after ten seconds", async (...path) => {
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
            setTimeout(() => resolve(Response.json({ pending: false })), 12_000);
          }),
      );
      const response = proxyToApi(
        new Request(`http://localhost:3000/api/${path.join("/")}`, { method: "POST" }),
        { path },
      );
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await response).status).toBe(200);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reports a refund timeout as an unconfirmed outcome instead of a failed refund", async () => {
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
        new Request("http://localhost:3000/api/payments/payment-1/refund", { method: "POST" }),
        { path: ["payments", "payment-1", "refund"] },
      );
      await vi.advanceTimersByTimeAsync(70_000);
      const result = await response;
      expect(result.status).toBe(504);
      expect(await result.json()).toMatchObject({
        code: "PAYPAL_OUTCOME_UNKNOWN",
        error: expect.stringContaining("Refresh this order"),
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["PAYPAL_RESPONSE_INVALID", "PAYPAL_OUTCOME_UNKNOWN", "private unknown code"])(
    "retains safe refund guidance for %s without leaking upstream details",
    async (code) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(
          { code, error: "private provider payload and secret token" },
          { status: 503 },
        ),
      );
      const result = await proxyToApi(
        new Request("http://localhost:3000/api/payments/payment-1/refund", { method: "POST" }),
        { path: ["payments", "payment-1", "refund"] },
      );
      const payload = await result.json();
      expect(payload.error).toContain("Refresh this order");
      expect(JSON.stringify(payload)).not.toContain("private");
    },
  );

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
    [503, "SHOPPING_AI_NOT_CONFIGURED", "AI service is not configured"],
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

describe("streaming chat proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function sseResponse(chunks: string[], init: { fail?: boolean } = {}) {
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
          else if (init.fail) controller.error(new TypeError("upstream reset"));
          else controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
      },
    );
  }

  it("relays each event without buffering, with no-transform headers and forwarded identity", async () => {
    vi.stubEnv("INTERNAL_PROXY_SECRET", "fixture-internal-proxy-secret-0123456789");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          'event: step\ndata: {"id":"mandate","label":"Reading your mandate","status":"running"}\n\n',
          'event: result\ndata: {"message":"done"}\n\n',
        ]),
      );
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent/chat/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "better-auth.session_token=session",
          "x-forwarded-for": "203.0.113.9",
        },
        body: "{}",
      }),
      { path: ["agent", "chat", "stream"] },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"id":"mandate"');
    expect(first).not.toContain("result");
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain("event: result");
    expect((await reader.read()).done).toBe(true);
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toMatch(/\/api\/agent\/chat\/stream$/u);
    const headers = init?.headers as Headers;
    expect(headers.get("cookie")).toBe("better-auth.session_token=session");
    expect(headers.get("x-mandatepay-client-ip")).toBe("203.0.113.9");
    expect(headers.get("x-mandatepay-proxy-secret")).toBe(
      "fixture-internal-proxy-secret-0123456789",
    );
  });

  it("ends a broken upstream stream with one safe error event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(['event: step\ndata: {"id":"catalog","label":"Searching","status":"run'], {
        fail: true,
      }),
    );
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent/chat/stream", { method: "POST" }),
      { path: ["agent", "chat", "stream"] },
    );
    const body = await response.text();
    expect(body).toMatch(
      /\n\nevent: error\ndata: \{"status":503,"code":"SHOPPING_STREAM_INTERRUPTED"/u,
    );
    expect(body).not.toContain("upstream reset");
  });

  it("reports the chat deadline as a timeout event", async () => {
    const deadline = new AbortController();
    deadline.abort();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException("Aborted", "AbortError"));
      },
    });
    const text = await new Response(relayEventStream(failing, deadline.signal)).text();
    expect(text).toContain('"status":504,"code":"SHOPPING_TIMEOUT"');
  });

  it("cancels the upstream request when the browser goes away", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ pull: () => undefined, cancel });
    await relayEventStream(upstream, new AbortController().signal).cancel("client left");
    expect(cancel).toHaveBeenCalledWith("client left");
  });

  it("keeps safe JSON errors and the chat deadline for checks before the stream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: "SHOPPING_AI_UNAVAILABLE", error: "private body" }, { status: 503 }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent/chat/stream", { method: "POST" }),
      { path: ["agent", "chat", "stream"] },
    );
    expect(timeout).toHaveBeenCalledWith(130_000);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "SHOPPING_AI_UNAVAILABLE",
      error: "The shopping assistant’s AI service is unavailable. Retry the same request shortly.",
    });
  });

  it("passes through ordinary 4xx JSON from the stream route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "Too many shopping requests." }, { status: 429 }),
    );
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent/chat/stream", { method: "POST" }),
      { path: ["agent", "chat", "stream"] },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("x-accel-buffering")).toBeNull();
  });

  it("does not open other agent paths", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent/chat/other", { method: "POST" }),
      { path: ["agent", "chat", "other"] },
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the read-only mandate policy simulator", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ simulated: true, decision: "ALLOW" }));
    const response = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/mandates/mandate-1/simulate", { method: "POST" }),
      { path: ["mandates", "mandate-1", "simulate"] },
    );
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/mandates\/mandate-1\/simulate$/);
  });

  it("forwards mandate credential reads, the JWKS and the verifier only", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({}));
    for (const path of [
      "mandates/mandate-1/credentials",
      "proposals/proposal-1/credentials",
      "credentials/jwks",
      "credentials/verify",
    ]) {
      const response = await proxyToApi(new Request(`http://127.0.0.1:3000/api/${path}`), {
        path: path.split("/"),
      });
      expect(response.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const path of ["credentials/other", "mandates/mandate-1/credentials/x", "credentials"]) {
      const response = await proxyToApi(new Request(`http://127.0.0.1:3000/api/${path}`), {
        path: path.split("/"),
      });
      expect(response.status).toBe(404);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("forwards agent token management but never the agent gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    for (const path of [["agent-tokens"], ["agent-tokens", "token-1", "revoke"]]) {
      const response = await proxyToApi(
        new Request(`http://127.0.0.1:3000/api/${path.join("/")}`, { method: "POST" }),
        { path },
      );
      expect(response.status).toBe(200);
    }
    const gateway = await proxyToApi(
      new Request("http://127.0.0.1:3000/api/agent-gateway/v1/mandates"),
      { path: ["agent-gateway", "v1", "mandates"] },
    );
    expect(gateway.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
