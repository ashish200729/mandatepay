import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "better-auth.session_token", value: "session-value" }],
  }),
}));

import {
  getServerSession,
  sanitizePrincipal,
  toClientPrincipal,
  SessionServiceUnavailableError,
} from "./server-api";

describe("server auth principal boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only the authenticated fields required by the workspace", () => {
    const principal = sanitizePrincipal({
      user: {
        id: "user_123",
        name: "Ashish",
        email: "ashish@example.com",
        autonomousPurchasingEnabled: false,
        role: "admin",
        sessionToken: "must-not-leave-server",
      },
    });

    expect(principal).toEqual({
      id: "user_123",
      name: "Ashish",
      email: "ashish@example.com",
      autonomousPurchasingEnabled: false,
    });
    expect(toClientPrincipal(principal!)).toEqual({
      name: "Ashish",
      email: "ashish@example.com",
      autonomousPurchasingEnabled: false,
    });
    expect(toClientPrincipal(principal!)).not.toHaveProperty("id");
    expect(toClientPrincipal(principal!)).not.toHaveProperty("role");
    expect(toClientPrincipal(principal!)).not.toHaveProperty("sessionToken");
  });

  it("rejects malformed or incomplete session payloads", () => {
    expect(sanitizePrincipal({ user: { id: "user_123", email: "a@example.com" } })).toBeNull();
    expect(sanitizePrincipal({ id: "user_123", name: "A", email: "a@example.com" })).toBeNull();
  });

  it("distinguishes an expired session from an unavailable service", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(getServerSession()).resolves.toBeNull();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(getServerSession()).rejects.toBeInstanceOf(SessionServiceUnavailableError);
    fetchMock.mockRejectedValue(new Error("private internal connection details"));
    await expect(getServerSession()).rejects.toThrow(
      "The session service is temporarily unavailable.",
    );
  });

  it("passes the browser session cookie to the internal API without exposing it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: "user_123",
            name: "Ashish",
            email: "ashish@example.com",
            autonomousPurchasingEnabled: false,
            sessionToken: "must-not-leave-server",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(getServerSession()).resolves.toEqual({
      id: "user_123",
      name: "Ashish",
      email: "ashish@example.com",
      autonomousPurchasingEnabled: false,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).cookie).toBe(
      "better-auth.session_token=session-value",
    );
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
