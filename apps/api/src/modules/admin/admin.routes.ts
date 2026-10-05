import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { AuthRuntime } from "../../auth.js";
import { originsFor, trustedOrigin } from "../../origins.js";
import { createMutationRateLimiter } from "../../services/rate-limits.js";
import { AdminAuthError, adminMe, requireSuperAdmin, type AdminIdentity } from "./admin.auth.js";

const signInSchema = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(128) })
  .strict();
const reauthSchema = z.object({ password: z.string().min(1).max(128) }).strict();
const emptySchema = z.object({}).strict();

export function registerAdminRoutes(
  app: FastifyInstance,
  options: {
    runtime: AuthRuntime | null;
    appUrl: string;
    adminOrigin?: string;
    nodeEnv: "development" | "test" | "production";
  },
) {
  const origins = originsFor(options.adminOrigin, options.nodeEnv);
  const authAttempts = createMutationRateLimiter({ maximum: 5 });
  const reads = createMutationRateLimiter({ maximum: 120 });
  const mutations = createMutationRateLimiter({ maximum: 20 });
  void app.register(
    async (scope) => {
      const identities = new WeakMap<FastifyRequest, AdminIdentity>();
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!options.runtime || !origins.length) {
          return sendError(
            reply,
            request,
            "ADMIN_UNAVAILABLE",
            503,
            "Administration is temporarily unavailable.",
          );
        }
        const signIn =
          request.method === "POST" && request.url.split("?")[0] === "/api/admin/session";
        const reauth =
          request.method === "POST" && request.url.split("?")[0] === "/api/admin/reauth";
        if (request.method !== "GET" && request.method !== "HEAD") {
          if (!trustedOrigin(request.headers.origin, origins)) {
            return sendError(
              reply,
              request,
              "ADMIN_FORBIDDEN",
              403,
              "Request origin is not trusted.",
            );
          }
          if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
            return sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Use a JSON request.");
          }
        }
        if (signIn || reauth) {
          const rate = authAttempts(request.ip);
          if (!rate.allowed) return rateLimited(reply, request, rate.retryAfter);
        }
        if (signIn) return;
        try {
          const identity = await requireSuperAdmin(options.runtime, request);
          const rate = (request.method === "GET" || request.method === "HEAD" ? reads : mutations)(
            identity.principalId,
          );
          if (!rate.allowed) return rateLimited(reply, request, rate.retryAfter);
          identities.set(request, identity);
        } catch (error) {
          return authError(reply, request, error);
        }
      });

      scope.get("/me", async (request) => ({
        data: adminMe(identities.get(request)!),
        requestId: request.id,
      }));

      async function credentialSignIn(
        request: FastifyRequest,
        reply: FastifyReply,
        expected?: AdminIdentity,
      ) {
        const parsed = expected
          ? reauthSchema.safeParse(request.body)
          : signInSchema.safeParse(request.body);
        if (!parsed.success)
          return sendError(
            reply,
            request,
            "ADMIN_INVALID_REQUEST",
            400,
            "Check your sign-in details.",
          );
        const email = expected
          ? expected.user.email
          : (parsed.data as z.infer<typeof signInSchema>).email;
        const runtime = options.runtime!;
        let newSessionId: string | undefined;
        try {
          const headers = fromNodeHeaders(request.headers);
          headers.delete("host");
          headers.delete("content-length");
          headers.delete("cookie");
          headers.set("x-mandatepay-client-ip", request.ip);
          headers.set("content-type", "application/json");
          const response = await runtime.auth.handler(
            new Request(new URL("/api/auth/sign-in/email", options.appUrl), {
              method: "POST",
              headers,
              body: JSON.stringify({ email, password: parsed.data.password, rememberMe: false }),
            }),
          );
          if (!response.ok) {
            request.log.warn(
              { event: "admin_sign_in_rejected", status: response.status },
              "Admin sign-in rejected",
            );
            if (response.status === 429) return rateLimited(reply, request, 60);
            if (response.status >= 500)
              return sendError(
                reply,
                request,
                "ADMIN_UNAVAILABLE",
                503,
                "Administration is temporarily unavailable.",
              );
            return sendError(
              reply,
              request,
              "ADMIN_SIGN_IN_REJECTED",
              401,
              "Unable to sign in with this account. Check your credentials and access.",
            );
          }
          // Better Auth 1.7.7 returns a token internally; it never leaves this module.
          const body = (await response.json()) as { token?: unknown };
          if (typeof body.token !== "string") throw new Error("Invalid auth response");
          const session = await runtime.database.session.findUnique({
            where: { token: body.token },
            select: { id: true },
          });
          if (!session) throw new Error("Missing auth session");
          newSessionId = session.id;
          const identity = await runtime.database.$transaction(async (tx) => {
            // Serialize login against principal changes and reauthentication against sign-out.
            await tx.$queryRaw`SELECT id FROM "AdminPrincipal" WHERE "singletonKey" = 'main' FOR UPDATE`;
            const current = await tx.session.findUnique({
              where: { id: session.id },
              include: { user: { include: { adminPrincipal: true } } },
            });
            const now = new Date();
            const principal = current?.user.adminPrincipal;
            if (
              !current ||
              current.expiresAt <= now ||
              !current.user.emailVerified ||
              !principal?.active ||
              principal.role !== "ADMIN_SUPER" ||
              principal.singletonKey !== "main"
            ) {
              throw new AdminAuthError(
                "ADMIN_SIGN_IN_REJECTED",
                401,
                "Unable to sign in with this account. Check your credentials and access.",
              );
            }
            if (expected) {
              if (current.userId !== expected.user.id || principal.id !== expected.principalId)
                throw new Error("Identity changed");
              await tx.$queryRaw`SELECT "sessionId" FROM "AdminSessionSecurity" WHERE "sessionId" = ${expected.sessionId} FOR UPDATE`;
              const previous = await tx.session.findUnique({
                where: { id: expected.sessionId },
                include: { adminSecurity: true },
              });
              if (
                !previous ||
                previous.expiresAt <= now ||
                !previous.adminSecurity ||
                previous.adminSecurity.principalId !== principal.id ||
                now.getTime() - previous.adminSecurity.lastSeenAt.getTime() >= 30 * 60_000
              ) {
                throw new AdminAuthError("ADMIN_UNAUTHORIZED", 401, "Sign in again to continue.");
              }
              await tx.session.delete({ where: { id: previous.id } });
            }
            await tx.adminSessionSecurity.create({
              data: {
                sessionId: current.id,
                principalId: principal.id,
                lastSeenAt: now,
                reauthenticatedAt: now,
              },
            });
            return {
              sessionId: current.id,
              principalId: principal.id,
              role: principal.role,
              user: {
                id: current.user.id,
                name: current.user.name,
                email: current.user.email,
                emailVerified: current.user.emailVerified,
              },
              expiresAt: current.expiresAt,
              lastSeenAt: now,
              reauthenticatedAt: now,
            } satisfies AdminIdentity;
          });
          const cookies = response.headers.getSetCookie();
          if (!cookies.length) throw new Error("Missing session cookie");
          reply.header("set-cookie", cookies);
          request.log.info(
            {
              event: expected ? "admin_reauth_succeeded" : "admin_login_succeeded",
              principalId: identity.principalId,
            },
            "Admin credentials verified",
          );
          return { data: adminMe(identity), requestId: request.id };
        } catch (error) {
          if (newSessionId)
            await runtime.database.session.deleteMany({ where: { id: newSessionId } });
          request.log.warn(
            {
              event: "admin_sign_in_failed",
              code: error instanceof AdminAuthError ? error.code : "ADMIN_UNAVAILABLE",
            },
            "Admin sign-in failed",
          );
          return authError(reply, request, error);
        }
      }
      scope.post("/session", { bodyLimit: 4096 }, (request, reply) =>
        credentialSignIn(request, reply),
      );
      scope.post("/reauth", { bodyLimit: 4096 }, (request, reply) =>
        credentialSignIn(request, reply, identities.get(request)!),
      );
      scope.post("/sign-out", { bodyLimit: 1024 }, async (request, reply) => {
        if (!emptySchema.safeParse(request.body).success)
          return sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid request.");
        try {
          const identity = identities.get(request)!;
          // Explicit database revocation fails closed even if Better Auth sign-out fails internally.
          await options.runtime!.database.session.deleteMany({
            where: { id: identity.sessionId, userId: identity.user.id },
          });
          const response = await options.runtime!.auth.api.signOut({
            headers: fromNodeHeaders(request.headers),
            asResponse: true,
          });
          reply.header("set-cookie", response.headers.getSetCookie());
          return reply.status(204).send();
        } catch (error) {
          return authError(reply, request, error);
        }
      });
      scope.setErrorHandler((error, request, reply) => {
        const invalid =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode < 500;
        return sendError(
          reply,
          request,
          invalid ? "ADMIN_INVALID_REQUEST" : "ADMIN_UNAVAILABLE",
          invalid ? 400 : 503,
          invalid
            ? "The request could not be processed."
            : "Administration is temporarily unavailable.",
        );
      });
      scope.setNotFoundHandler((request, reply) =>
        sendError(reply, request, "ADMIN_TARGET_NOT_FOUND", 404, "Not found."),
      );
    },
    { prefix: "/api/admin" },
  );
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  code: string,
  status: number,
  message: string,
) {
  return reply.status(status).send({ error: { code, message, requestId: request.id } });
}
function authError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  return error instanceof AdminAuthError
    ? sendError(reply, request, error.code, error.status, error.message)
    : sendError(
        reply,
        request,
        "ADMIN_UNAVAILABLE",
        503,
        "Administration is temporarily unavailable.",
      );
}
function rateLimited(reply: FastifyReply, request: FastifyRequest, seconds: number) {
  reply.header("retry-after", seconds);
  return sendError(
    reply,
    request,
    "ADMIN_RATE_LIMITED",
    429,
    "Too many requests. Try again shortly.",
  );
}
