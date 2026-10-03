import { describe, expect, it, vi } from "vitest";
import { createResendAuthEmailSender } from "./auth-email.js";
import { createAuthRuntime } from "./auth.js";

describe("authentication email delivery", () => {
  it("sends only to the fixed HTTPS endpoint with bounded delivery and no redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const sender = createResendAuthEmailSender({
      apiKey: "fake-test-key",
      from: "auth@example.com",
      fetchImpl,
    });
    await sender({ to: "reader@example.com", subject: "Verify email", text: "Test link" });
    const [target, options] = fetchImpl.mock.calls[0]!;
    expect(target).toBe("https://api.resend.com/emails");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toMatchObject({ authorization: "Bearer fake-test-key" });
    expect(JSON.parse(String(options?.body))).toEqual({
      from: "auth@example.com",
      to: ["reader@example.com"],
      subject: "Verify email",
      text: "Test link",
    });
  });

  it.each(["http", "network"])("redacts %s provider failures", async (failure) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (failure === "http")
      fetchImpl.mockResolvedValue(new Response("secret-provider-response", { status: 401 }));
    else fetchImpl.mockRejectedValue(new Error("secret-network-detail"));
    const sender = createResendAuthEmailSender({
      apiKey: "fake-test-key",
      from: "auth@example.com",
      fetchImpl,
    });
    await expect(
      sender({ to: "reader@example.com", subject: "Test", text: "Test" }),
    ).rejects.toThrow(/^Authentication email delivery failed\.$/);
  });

  it("rejects production auth without delivery or when verification is disabled", () => {
    const options = {
      databaseUrl: "postgresql://unused",
      authSecret: "test-authentication-secret-at-least-32",
      appUrl: "https://example.com",
      nodeEnv: "production" as const,
    };
    expect(() => createAuthRuntime(options)).toThrow("RESEND_API_KEY and AUTH_EMAIL_FROM");
    expect(() => createAuthRuntime({ ...options, requireEmailVerification: false })).toThrow(
      "Production requires email verification",
    );
    expect(() =>
      createAuthRuntime({ ...options, nodeEnv: "test", requireEmailVerification: true }),
    ).toThrow("RESEND_API_KEY and AUTH_EMAIL_FROM");
  });
});
