import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@mandatepay/database";
import { createAuthRuntime } from "./auth.js";
import type { AuthEmail } from "./auth-email.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("Better Auth verification and recovery with PostgreSQL", () => {
  const database = databaseUrl ? createPrismaClient(databaseUrl) : null;
  const appUrl = "http://localhost:3000";
  const messages: AuthEmail[] = [];
  let failDelivery = false;
  let deliveryFailures = 0;
  const runtime = database
    ? createAuthRuntime({
        database,
        databaseUrl: databaseUrl!,
        authSecret: "test-only-recovery-secret-with-32-characters",
        appUrl,
        nodeEnv: "test",
        requireEmailVerification: true,
        emailSender: async (email) => {
          if (failDelivery) throw new Error("Fake provider failure");
          messages.push(email);
        },
        onEmailDeliveryError: () => {
          deliveryFailures += 1;
        },
      })
    : null;
  const userIds: string[] = [];
  let sequence = 0;

  async function request(path: string, body?: object) {
    if (!runtime) throw new Error("Missing test runtime");
    return runtime.auth.handler(
      new Request(`${appUrl}/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: appUrl,
          "content-type": "application/json",
          "x-forwarded-for": `192.0.2.${++sequence}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  function emailLink(message: AuthEmail) {
    const link = message.text.match(/https?:\/\/[^\s]+/)?.[0];
    if (!link) throw new Error("Missing email link");
    return new URL(link);
  }

  async function signup() {
    const email = `recovery-${randomUUID()}@mandatepay.local`;
    const response = await request("sign-up/email", {
      name: "Recovery Test",
      email,
      password: "original-password1234",
      callbackURL: `${appUrl}/verify-email`,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string | null; user: { id: string } };
    userIds.push(body.user.id);
    expect(body.token).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await runtime!.flushEmails();
    const message = [...messages].reverse().find((item) => item.to === email)!;
    return { email, id: body.user.id as string, verificationLink: emailLink(message) };
  }

  afterAll(async () => {
    await runtime?.close();
    if (database && userIds.length) {
      await database.verification.deleteMany({ where: { value: { in: userIds } } });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await database?.$disconnect();
  });

  it("requires verification and preserves trusted callbacks", async () => {
    const user = await signup();
    const denied = await request("sign-in/email", {
      email: user.email,
      password: "original-password1234",
      callbackURL: `${appUrl}/verify-email`,
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
    const untrusted = new URL(user.verificationLink);
    untrusted.searchParams.set("callbackURL", "https://evil.example/steal");
    expect((await request(`verify-email${untrusted.search}`)).status).toBe(403);
    const verified = await request(`verify-email${user.verificationLink.search}`);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${appUrl}/verify-email`);
    expect((await database!.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(
      true,
    );
    expect(
      (await request("sign-in/email", { email: user.email, password: "original-password1234" }))
        .status,
    ).toBe(200);
    expect((await request("verify-email?token=invalid-token")).status).toBe(401);
  });

  it("returns the same recovery response, consumes tokens once, and revokes existing sessions", async () => {
    const user = await signup();
    await request(`verify-email${user.verificationLink.search}`);
    const signedIn = await request("sign-in/email", {
      email: user.email,
      password: "original-password1234",
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((item) => item.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("better-auth");
    const known = await request("request-password-reset", {
      email: user.email,
      redirectTo: `${appUrl}/reset-password`,
    });
    const unknown = await request("request-password-reset", {
      email: `absent-${randomUUID()}@mandatepay.local`,
      redirectTo: `${appUrl}/reset-password`,
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    await runtime!.flushEmails();
    const resetLink = emailLink([...messages].reverse().find((item) => item.to === user.email)!);
    const callback = await request(
      `reset-password/${resetLink.pathname.split("/").at(-1)}${resetLink.search}`,
    );
    expect(callback.status).toBe(302);
    const token = new URL(callback.headers.get("location")!).searchParams.get("token")!;
    const stored = await (
      await runtime!.auth.$context
    ).internalAdapter.findVerificationValue(`reset-password:${token}`);
    expect(stored!.identifier).not.toContain(token);
    expect((await request("reset-password", { token, newPassword: "short" })).status).toBe(400);
    const competingResets = await Promise.all([
      request("reset-password", { token, newPassword: "updated-password1234" }),
      request("reset-password", { token, newPassword: "updated-password1234" }),
    ]);
    expect(competingResets.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(
      (await request("reset-password", { token, newPassword: "another-password1234" })).status,
    ).toBe(400);
    const session = await runtime!.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).toBeNull();
    expect(await database!.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await request("sign-in/email", { email: user.email, password: "original-password1234" }))
        .status,
    ).toBe(401);
    expect(
      (await request("sign-in/email", { email: user.email, password: "updated-password1234" }))
        .status,
    ).toBe(200);
  });

  it("rejects expired reset tokens and untrusted recovery redirects", async () => {
    const user = await signup();
    expect(
      (
        await request("request-password-reset", {
          email: user.email,
          redirectTo: "https://evil.example/steal",
        })
      ).status,
    ).toBe(403);
    await request("request-password-reset", {
      email: user.email,
      redirectTo: `${appUrl}/reset-password`,
    });
    await runtime!.flushEmails();
    const resetLink = emailLink([...messages].reverse().find((item) => item.to === user.email)!);
    const token = resetLink.pathname.split("/").at(-1)!;
    const stored = await (
      await runtime!.auth.$context
    ).internalAdapter.findVerificationValue(`reset-password:${token}`);
    await database!.verification.update({
      where: { id: stored!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const callback = await request(`reset-password/${token}${resetLink.search}`);
    expect(callback.headers.get("location")).toBe(`${appUrl}/reset-password?error=INVALID_TOKEN`);
    expect(
      (await request("reset-password", { token, newPassword: "updated-password1234" })).status,
    ).toBe(400);
  });

  it("keeps known and unknown recovery responses equal when delivery fails", async () => {
    const user = await signup();
    failDelivery = true;
    try {
      const known = await request("request-password-reset", {
        email: user.email,
        redirectTo: `${appUrl}/reset-password`,
      });
      const unknown = await request("request-password-reset", {
        email: `absent-${randomUUID()}@mandatepay.local`,
        redirectTo: `${appUrl}/reset-password`,
      });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());
      await runtime!.flushEmails();
      expect(deliveryFailures).toBe(1);
    } finally {
      failDelivery = false;
    }
  });
});
