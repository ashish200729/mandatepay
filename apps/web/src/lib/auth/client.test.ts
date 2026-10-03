import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthClientError,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signUp,
} from "./client";

describe("auth recovery client", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps sessionless signup responses for the check-email state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: null, user: { id: "test-user" } })),
    );
    expect(
      (
        await signUp({
          name: "Test",
          email: "test@example.com",
          password: "password1234",
          callbackURL: "https://example.com/verify-email",
        })
      )?.token,
    ).toBeNull();
  });
  it("posts reset and verification payloads through the same-origin BFF", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ status: true })));
    await sendVerificationEmail("test@example.com", "https://example.com/verify-email");
    await requestPasswordReset("test@example.com", "https://example.com/reset-password");
    await resetPassword("fake-reset-token", "new-password1234");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/send-verification-email",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password",
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
      { email: "test@example.com", callbackURL: "https://example.com/verify-email" },
      { email: "test@example.com", redirectTo: "https://example.com/reset-password" },
      { token: "fake-reset-token", newPassword: "new-password1234" },
    ]);
    expect(
      fetchMock.mock.calls.every(([, options]) => options?.credentials === "same-origin"),
    ).toBe(true);
  });
  it("retains the verification-required error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }), {
        status: 403,
      }),
    );
    await expect(
      signUp({ name: "Test", email: "test@example.com", password: "password1234" }),
    ).rejects.toMatchObject({ name: AuthClientError.name, code: "EMAIL_NOT_VERIFIED" });
  });
});
