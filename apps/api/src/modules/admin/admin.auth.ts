import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import type { AuthRuntime } from "../../auth.js";

export const ADMIN_IDLE_MS = 30 * 60_000;
export const ADMIN_FRESH_MS = 10 * 60_000;

export class AdminAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AdminIdentity = {
  sessionId: string;
  principalId: string;
  role: "ADMIN_SUPER";
  user: { id: string; name: string | null; email: string; emailVerified: boolean };
  expiresAt: Date;
  lastSeenAt: Date;
  reauthenticatedAt: Date;
};

export function unauthorized(): never {
  throw new AdminAuthError("ADMIN_UNAUTHORIZED", 401, "Sign in again to continue.");
}

export function forbidden(): never {
  throw new AdminAuthError("ADMIN_FORBIDDEN", 403, "This account cannot access administration.");
}

/** Reads authority from the database on every request. Cookies only identify a session. */
export async function requireAdmin(
  runtime: AuthRuntime,
  request: Pick<FastifyRequest, "headers">,
): Promise<AdminIdentity> {
  const authenticated = await runtime.auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!authenticated?.session.id) unauthorized();
  return runtime.database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "sessionId" FROM "AdminSessionSecurity" WHERE "sessionId" = ${authenticated.session.id} FOR UPDATE`;
    const now = new Date();
    const session = await tx.session.findUnique({
      where: { id: authenticated.session.id },
      include: { user: { include: { adminPrincipal: true } }, adminSecurity: true },
    });
    if (!session || session.expiresAt <= now || session.userId !== authenticated.user.id)
      unauthorized();
    const principal = session.user.adminPrincipal;
    if (
      !session.user.emailVerified ||
      session.user.disabledAt ||
      !principal?.active ||
      principal.singletonKey !== "main" ||
      principal.role !== "ADMIN_SUPER"
    )
      forbidden();
    const security = session.adminSecurity;
    if (
      !security ||
      security.principalId !== principal.id ||
      security.lastSeenAt.getTime() <= now.getTime() - ADMIN_IDLE_MS ||
      security.lastSeenAt > now ||
      security.reauthenticatedAt > now
    )
      unauthorized();
    await tx.adminSessionSecurity.update({
      where: { sessionId: session.id },
      data: { lastSeenAt: now },
    });
    return {
      sessionId: session.id,
      principalId: principal.id,
      role: principal.role,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      },
      expiresAt: session.expiresAt,
      lastSeenAt: now,
      reauthenticatedAt: security.reauthenticatedAt,
    };
  });
}

export async function requireSuperAdmin(
  runtime: AuthRuntime,
  request: Pick<FastifyRequest, "headers">,
) {
  const identity = await requireAdmin(runtime, request);
  if (identity.role !== "ADMIN_SUPER") forbidden();
  return identity;
}

/** Future sensitive handlers call this again immediately before committing their action. */
export async function requireFreshAdminAuth(
  runtime: AuthRuntime,
  request: Pick<FastifyRequest, "headers">,
) {
  const identity = await requireSuperAdmin(runtime, request);
  if (Date.now() - identity.reauthenticatedAt.getTime() >= ADMIN_FRESH_MS) {
    throw new AdminAuthError(
      "ADMIN_REAUTH_REQUIRED",
      403,
      "Confirm your password before this action.",
    );
  }
  return identity;
}

export function adminMe(identity: AdminIdentity) {
  return {
    user: identity.user,
    principal: { id: identity.principalId, role: identity.role },
    session: {
      expiresAt: identity.expiresAt.toISOString(),
      idleExpiresAt: new Date(
        Math.min(identity.expiresAt.getTime(), identity.lastSeenAt.getTime() + ADMIN_IDLE_MS),
      ).toISOString(),
      freshAuthUntil: new Date(
        Math.min(
          identity.expiresAt.getTime(),
          identity.reauthenticatedAt.getTime() + ADMIN_FRESH_MS,
        ),
      ).toISOString(),
    },
    capabilities: [
      "session:read",
      "session:reauthenticate",
      "session:sign-out",
      "audit:read",
      "overview:read",
      "users:read",
      "mandates:read",
      "proposals:read",
      "approvals:read",
      "orders:read",
      "payments:read",
      "refunds:read",
      "webhooks:read",
      "domain-audit:read",
      "exports:read",
      "users:disable",
      "users:enable",
      "users:revoke-sessions",
      "users:disable-autonomy",
      "users:notes",
      "mandates:pause",
      "mandates:revoke",
      "proposals:re-evaluate",
      "orders:reconcile",
      "payments:reconcile",
      "payments:refund",
      "refunds:refresh",
      "webhooks:retry",
      "webhooks:reconcile",
      "system:read",
      "agent:read",
    ],
  };
}
