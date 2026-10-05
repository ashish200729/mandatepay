import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createPrismaClient, type DatabaseClient } from "@mandatepay/database";
import { createResendAuthEmailSender, type AuthEmailSender } from "./auth-email.js";
import { originsFor } from "./origins.js";

export type AuthNodeEnvironment = "development" | "test" | "production";

export interface AuthRuntimeOptions {
  database?: DatabaseClient;
  databaseUrl: string;
  authSecret: string;
  appUrl: string;
  adminOrigin?: string;
  nodeEnv: AuthNodeEnvironment;
  requireEmailVerification?: boolean;
  resendApiKey?: string;
  authEmailFrom?: string;
  emailSender?: AuthEmailSender;
  onEmailDeliveryError?: () => void;
  /** Programmatic provisioning only; rejected outside an isolated test database. */
  testRateLimitMaximum?: number;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export function trustedOriginsFor(
  appUrl: string,
  nodeEnv: AuthNodeEnvironment,
  adminOrigin?: string,
): string[] {
  return [...new Set([...originsFor(appUrl, nodeEnv), ...originsFor(adminOrigin, nodeEnv)])];
}

export function createAuthRuntime(options: AuthRuntimeOptions) {
  if (!options.databaseUrl) {
    throw new AuthConfigurationError("DATABASE_URL is required for authentication.");
  }
  if (!options.authSecret || options.authSecret.length < 32) {
    throw new AuthConfigurationError("AUTH_SECRET must be at least 32 characters.");
  }
  if (
    options.testRateLimitMaximum !== undefined &&
    (options.nodeEnv !== "test" ||
      !decodeURIComponent(new URL(options.databaseUrl).pathname).endsWith("_test") ||
      !Number.isSafeInteger(options.testRateLimitMaximum) ||
      options.testRateLimitMaximum < 1 ||
      options.testRateLimitMaximum > 500)
  )
    throw new AuthConfigurationError("Fixture rate limits require an isolated test database.");

  const isProduction = options.nodeEnv === "production";
  const requireEmailVerification = options.requireEmailVerification ?? isProduction;
  const emailSender =
    options.emailSender ??
    (options.resendApiKey && options.authEmailFrom
      ? createResendAuthEmailSender({ apiKey: options.resendApiKey, from: options.authEmailFrom })
      : undefined);
  if (isProduction && !requireEmailVerification) {
    throw new AuthConfigurationError("Production requires email verification.");
  }
  if ((isProduction || requireEmailVerification) && !emailSender) {
    throw new AuthConfigurationError(
      "Email verification requires RESEND_API_KEY and AUTH_EMAIL_FROM.",
    );
  }
  const pendingEmails = new Set<Promise<void>>();
  function queueEmail(email: Parameters<AuthEmailSender>[0]) {
    if (!emailSender) return;
    // Detach delivery from responses to avoid revealing registered addresses by timing or failure.
    const task = Promise.resolve()
      .then(() => emailSender(email))
      .catch(() => {
        try {
          if (options.onEmailDeliveryError) options.onEmailDeliveryError();
          else console.error("Authentication email delivery failed.");
        } catch {
          // Reporting failures must not reject detached delivery promises.
          console.error("Authentication email delivery failed.");
        }
      });
    pendingEmails.add(task);
    void task.then(() => pendingEmails.delete(task));
  }
  async function flushEmails() {
    await Promise.all([...pendingEmails]);
  }
  const ownsDatabase = !options.database;
  const database = options.database ?? createPrismaClient(options.databaseUrl);

  const auth = betterAuth({
    appName: "MandatePay",
    baseURL: options.appUrl,
    secret: options.authSecret,
    trustedOrigins: trustedOriginsFor(options.appUrl, options.nodeEnv, options.adminOrigin),
    database: prismaAdapter(database, {
      provider: "postgresql",
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: !requireEmailVerification,
      requireEmailVerification,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(emailSender
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              queueEmail({
                to: user.email,
                subject: "Reset your MandatePay password",
                text: `Reset your password using this link (valid for 30 minutes):\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
              });
            },
          }
        : {}),
    },
    ...(emailSender
      ? {
          emailVerification: {
            sendOnSignUp: requireEmailVerification,
            sendOnSignIn: requireEmailVerification,
            autoSignInAfterVerification: false,
            expiresIn: 60 * 60,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              queueEmail({
                to: user.email,
                subject: "Verify your MandatePay email",
                text: `Verify your email using this link (valid for one hour):\n\n${url}\n\nIf you did not create an account, you can ignore this email.`,
              });
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        globalAutonomousPurchasingEnabled: {
          type: "boolean",
          required: true,
          defaultValue: false,
          input: false,
        },
      },
    },
    session: {
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: false,
      },
    },
    verification: {
      storeIdentifier: "hashed",
    },
    rateLimit: {
      enabled: true,
      ...(options.testRateLimitMaximum === undefined
        ? {}
        : {
            customRules: { "/**": { window: 60, max: options.testRateLimitMaximum } },
          }),
    },
    advanced: {
      // Only the Fastify bridge writes this header from its socket-derived IP.
      ipAddress: { ipAddressHeaders: ["x-mandatepay-client-ip"] },
      useSecureCookies: isProduction,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
      },
      database: {
        joins: true,
        validateSchema: true,
      },
    },
  });

  return {
    auth,
    database,
    requireEmailVerification,
    flushEmails,
    async close() {
      await flushEmails();
      if (ownsDatabase) {
        await database.$disconnect();
      }
    },
  };
}

export type AuthRuntime = ReturnType<typeof createAuthRuntime>;
