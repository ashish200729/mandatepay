import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { proxyAdmin } from "./proxy";
import { parseAdminMe } from "./session";

const identity = {
  user: { id: "user", email: "admin@example.test", name: "Admin", emailVerified: true },
  principal: { id: "principal", role: "ADMIN_SUPER" },
  session: {
    expiresAt: "2026-10-06T00:00:00Z",
    idleExpiresAt: "2026-10-05T01:00:00Z",
    freshAuthUntil: "2026-10-05T00:40:00Z",
  },
  capabilities: ["session:read"],
};
function request(path = "session", options: RequestInit = {}) {
  return new Request(`http://localhost:3001/api/admin/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3001",
      "content-type": "application/json",
      cookie: "fixture-cookie",
    },
    body: JSON.stringify({ email: "admin@example.test", password: "fixture-password" }),
    ...options,
  });
}
describe("admin BFF security", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("ADMIN_ORIGIN", "http://localhost:3001");
    vi.stubEnv("API_URL", "http://localhost:4000");
  });
  it("denies arbitrary paths, methods, queries and untrusted/missing origin before upstream access", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const path of [["auth", "sign-up"], [".."], ["payments"], ["session", "extra"]])
      expect((await proxyAdmin(request(), { path })).status).toBe(404);
    expect(
      (await proxyAdmin(request("session", { method: "PATCH" }), { path: ["session"] })).status,
    ).toBe(405);
    expect((await proxyAdmin(request("session?token=private"), { path: ["session"] })).status).toBe(
      400,
    );
    const rejectedHeaders: Record<string, string>[] = [
      { "content-type": "application/json" },
      { origin: "http://localhost:3000", "content-type": "application/json" },
      { origin: "https://evil.example", "content-type": "application/json" },
    ];
    for (const headers of rejectedHeaders)
      expect(
        (await proxyAdmin(request("session", { headers }), { path: ["session"] })).status,
      ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streamed bodies and never forwards arbitrary authorization or trusted headers", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: identity }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(
      (await proxyAdmin(request("session", { body: "x".repeat(4097) }), { path: ["session"] }))
        .status,
    ).toBe(413);
    const input = request();
    input.headers.set("authorization", "private-bearer");
    input.headers.set("x-mandatepay-admin-authorized", "true");
    await proxyAdmin(input, { path: ["session"] });
    const headers = fetcher.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-mandatepay-admin-authorized")).toBeNull();
    expect(headers.get("origin")).toBe("http://localhost:3001");
  });
  it("validates origin and Host when Next reconstructs an internal URL behind TLS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_ORIGIN", "https://admin.example");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: identity })));
    const headers = {
      origin: "https://admin.example",
      host: "admin.example",
      "content-type": "application/json",
    };
    const input = new Request("http://localhost:3001/api/admin/session", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect((await proxyAdmin(input, { path: ["session"] })).status).toBe(200);
    fetcher.mockClear();
    input.headers.set("host", "evil.example");
    expect((await proxyAdmin(input, { path: ["session"] })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("whitelists successful identities and forwards cookies only for session establishment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            ...identity,
            token: "private-token",
            user: { ...identity.user, password: "private-hash" },
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=fixture; HttpOnly; SameSite=Lax",
          },
        },
      ),
    );
    const response = await proxyAdmin(request(), { path: ["session"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const output = await response.text();
    expect(output).not.toContain("private-token");
    expect(output).not.toContain("private-hash");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      parseAdminMe({ data: { ...identity, principal: { id: "x", role: "CUSTOMER" } } }),
    ).toBeNull();
  });
  it("preserves authoritative HEAD authorization without expecting a JSON body", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const status of [200, 401, 403]) {
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      const response = await proxyAdmin(
        new Request("http://localhost:3001/api/admin/me", { method: "HEAD" }),
        { path: ["me"] },
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });
  it("redacts upstream errors/cookies, preserves rate limits, and fails closed on invalid/failed upstream responses", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "ADMIN_RATE_LIMITED", message: "private-secret" } }),
        { status: 429, headers: { "retry-after": "60", "set-cookie": "leaked=token" } },
      ),
    );
    const limited = await proxyAdmin(request(), { path: ["session"] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(await limited.text()).not.toContain("private-secret");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ token: "unsafe" })));
    expect((await proxyAdmin(request(), { path: ["session"] })).status).toBe(503);
    fetcher.mockRejectedValueOnce(new Error("private-secret"));
    expect((await proxyAdmin(request(), { path: ["session"] })).status).toBe(503);
  });
});
