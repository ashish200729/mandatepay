import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import {
  AdminAuditRepository,
  AdminAuditQuerySchema,
  isDatabaseError,
  type AppendAdminAuditEventInput,
} from "@mandatepay/database";
import type { PayPalClient } from "@mandatepay/paypal";
import { AdminTraceIdSchema } from "@mandatepay/shared";
import type { AuthRuntime } from "../../auth.js";
import { originsFor, trustedOrigin } from "../../origins.js";
import { createMutationRateLimiter } from "../../services/rate-limits.js";
import { AdminAuthError, adminMe, requireSuperAdmin, type AdminIdentity } from "./admin.auth.js";
import { registerAdminOperationRoutes } from "./admin.operations.js";
import { registerAdminControlRoutes } from "./admin.controls.js";
import { registerAdminFinanceRoutes } from "./admin.finance.js";
import { registerAdminSettingRoutes } from "./admin.settings.js";

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
    discoveryMode?: string;
    readMaximum?: number;
    mutationMaximum?: number;
    financialMaximum?: number;
    getPaypal?: () => PayPalClient | null;
  },
) {
  const origins = originsFor(options.adminOrigin, options.nodeEnv);
  const authAttempts = createMutationRateLimiter({ maximum: 5 });
  const reads = createMutationRateLimiter({ maximum: options.readMaximum ?? 120 });
  const mutations = createMutationRateLimiter({ maximum: options.mutationMaximum ?? 20 });
  const financial = createMutationRateLimiter({ maximum: options.financialMaximum ?? 5 });
  void app.register(
    async (scope) => {
      const identities = new WeakMap<FastifyRequest, AdminIdentity>();
      const correlations = new WeakMap<FastifyRequest, string>();
      const trace = (request: FastifyRequest) => ({
        requestId: request.id,
        correlationId: correlations.get(request) ?? request.id,
      });
      const actor = (identity: AdminIdentity) => ({
        principalId: identity.principalId,
        userId: identity.user.id,
        role: identity.role,
      });
      async function failedCredentials(
        request: FastifyRequest,
        expected: AdminIdentity | undefined,
        code: AppendAdminAuditEventInput["errorCode"],
      ) {
        await new AdminAuditRepository(options.runtime!.database).append({
          actor: expected ? actor(expected) : null,
          action: expected ? "ADMIN_REAUTH_FAILED" : "ADMIN_LOGIN_FAILED",
          targetType: "ADMIN_AUTH",
          targetId: "main",
          reason: expected
            ? "Administrator password confirmation rejected."
            : "Administrator credential sign-in rejected.",
          ...trace(request),
          result: "FAILURE",
          errorCode: code,
        });
      }
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        const correlation = request.headers["x-correlation-id"];
        if (correlation !== undefined && !AdminTraceIdSchema.safeParse(correlation).success)
          return sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid correlation ID.");
        correlations.set(request, typeof correlation === "string" ? correlation : request.id);
        reply
          .header("x-request-id", request.id)
          .header("x-correlation-id", correlations.get(request)!);
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
          if (isAdminFinancialMutation(request.method, request.url)) {
            const money = financial(identity.principalId);
            if (!money.allowed) return rateLimited(reply, request, money.retryAfter);
          }
          identities.set(request, identity);
          (request as FastifyRequest & { adminPrincipalId?: string }).adminPrincipalId =
            identity.principalId;
        } catch (error) {
          return authError(reply, request, error);
        }
      });

      scope.get("/me", async (request) => ({
        data: adminMe(identities.get(request)!),
        requestId: request.id,
      }));

      registerAdminOperationRoutes(scope, {
        getDatabase: () => options.runtime!.database,
        getSecret: () => options.runtime!.auth.options.secret,
        discoveryMode: options.discoveryMode,
        sendError,
        trace,
      });
      registerAdminControlRoutes(scope, {
        getDatabase: () => options.runtime!.database,
        getSecret: () => options.runtime!.auth.options.secret,
        runtime: () => options.runtime!,
        identity: (request) => identities.get(request)!,
        sendError,
        trace,
      });
      registerAdminFinanceRoutes(scope, {
        getDatabase: () => options.runtime!.database,
        getSecret: () => options.runtime!.auth.options.secret,
        getPaypal: () => options.getPaypal?.() ?? null,
        runtime: () => options.runtime!,
        identity: (request) => identities.get(request)!,
        sendError,
        trace,
      });
      registerAdminSettingRoutes(scope, {
        getDatabase: () => options.runtime!.database,
        runtime: () => options.runtime!,
        identity: (request) => identities.get(request)!,
        sendError,
        trace,
      });

      scope.get("/audit", async (request, reply) => {
        const parsed = AdminAuditQuerySchema.safeParse(request.query);
        if (!parsed.success)
          return sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid audit filters.");
        try {
          const repository = new AdminAuditRepository(
            options.runtime!.database,
            options.runtime!.auth.options.secret,
          );
          return { ...(await repository.list(parsed.data)), ...trace(request) };
        } catch (error) {
          if (isDatabaseError(error) && error.code === "INVALID_DOMAIN_INPUT")
            return sendError(
              reply,
              request,
              "ADMIN_INVALID_REQUEST",
              400,
              "Invalid audit filters or cursor.",
            );
          return authError(reply, request, error);
        }
      });
      scope.get<{ Params: { id: string } }>("/audit/:id", async (request, reply) => {
        if (!z.uuid().safeParse(request.params.id).success)
          return sendError(reply, request, "ADMIN_INVALID_REQUEST", 400, "Invalid audit ID.");
        const event = await new AdminAuditRepository(options.runtime!.database).findById(
          request.params.id,
        );
        if (!event)
          return sendError(reply, request, "ADMIN_TARGET_NOT_FOUND", 404, "Audit event not found.");
        return { data: event, ...trace(request) };
      });

      async function credentialSignIn(
        request: FastifyRequest,
        reply: FastifyReply,
        expected?: AdminIdentity,
      ) {
        const parsed = expected
          ? reauthSchema.safeParse(request.body)
          : signInSchema.safeParse(request.body);
        if (!parsed.success) {
          await failedCredentials(request, expected, "ADMIN_INVALID_REQUEST");
          return sendError(
            reply,
            request,
            "ADMIN_INVALID_REQUEST",
            400,
            "Check your sign-in details.",
          );
        }
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
            await failedCredentials(
              request,
              expected,
              response.status === 429
                ? "ADMIN_RATE_LIMITED"
                : response.status >= 500
                  ? "ADMIN_UNAVAILABLE"
                  : "ADMIN_SIGN_IN_REJECTED",
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
          const cookies = response.headers.getSetCookie();
          if (!cookies.length) throw new Error("Missing session cookie");
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
              current.user.disabledAt ||
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
            await new AdminAuditRepository(tx).append({
              actor: { principalId: principal.id, userId: current.userId, role: principal.role },
              action: expected ? "ADMIN_REAUTH_SUCCEEDED" : "ADMIN_LOGIN_SUCCEEDED",
              targetType: "ADMIN_SESSION",
              targetId: current.id,
              reason: expected
                ? "Administrator password confirmed."
                : "Administrator credentials verified.",
              ...trace(request),
              result: "SUCCESS",
              afterSummaryJson: {
                expiresAt: current.expiresAt.toISOString(),
                freshAuthUntil: new Date(now.getTime() + 10 * 60_000).toISOString(),
                revoked: false,
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
          await failedCredentials(
            request,
            expected,
            error instanceof AdminAuthError && error.code === "ADMIN_SIGN_IN_REJECTED"
              ? "ADMIN_SIGN_IN_REJECTED"
              : error instanceof AdminAuthError && error.code === "ADMIN_UNAUTHORIZED"
                ? "ADMIN_UNAUTHORIZED"
                : "ADMIN_UNAVAILABLE",
          );
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
          await options.runtime!.database.$transaction(async (tx) => {
            await tx.session.deleteMany({
              where: { id: identity.sessionId, userId: identity.user.id },
            });
            await new AdminAuditRepository(tx).append({
              actor: actor(identity),
              action: "ADMIN_LOGOUT_SUCCEEDED",
              targetType: "ADMIN_SESSION",
              targetId: identity.sessionId,
              reason: "Administrator session revoked.",
              ...trace(request),
              result: "SUCCESS",
              beforeSummaryJson: { revoked: false },
              afterSummaryJson: { revoked: true },
            });
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
        if (error instanceof AdminAuthError)
          return sendError(reply, request, error.code, error.status, error.message);
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

function isAdminFinancialMutation(method: string, url: string) {
  return (
    method === "POST" &&
    /\/(?:orders|payments|refunds|webhooks)\/[^/]+\/(?:reconcile|refund|refresh|retry)(?:\?|$)/u.test(
      url.split("?")[0] ?? "",
    )
  );
}
