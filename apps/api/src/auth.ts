import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createPrismaClient, type DatabaseClient } from "@mandatepay/database";

export type AuthNodeEnvironment = "development" | "test" | "production";

export interface AuthRuntimeOptions {
  database?: DatabaseClient;
  databaseUrl: string;
  authSecret: string;
  appUrl: string;
  nodeEnv: AuthNodeEnvironment;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export function trustedOriginsFor(appUrl: string, nodeEnv: AuthNodeEnvironment): string[] {
  const configured = new URL(appUrl);
  const origins = new Set<string>([configured.origin]);

  if (
    nodeEnv !== "production" &&
    (configured.hostname === "localhost" || configured.hostname === "127.0.0.1")
  ) {
    const alias = configured.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const port = configured.port ? ":" + configured.port : "";
    origins.add(new URL(configured.protocol + "//" + alias + port).origin);
  }

  return [...origins];
}

export function createAuthRuntime(options: AuthRuntimeOptions) {
  if (!options.databaseUrl) {
    throw new AuthConfigurationError("DATABASE_URL is required for authentication.");
  }
  if (!options.authSecret || options.authSecret.length < 32) {
    throw new AuthConfigurationError("AUTH_SECRET must be at least 32 characters.");
  }

  const ownsDatabase = !options.database;
  const database = options.database ?? createPrismaClient(options.databaseUrl);
  const isProduction = options.nodeEnv === "production";

  const auth = betterAuth({
    appName: "MandatePay",
    baseURL: options.appUrl,
    secret: options.authSecret,
    trustedOrigins: trustedOriginsFor(options.appUrl, options.nodeEnv),
    database: prismaAdapter(database, {
      provider: "postgresql",
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
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
    rateLimit: {
      enabled: true,
    },
    advanced: {
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
    async close() {
      if (ownsDatabase) {
        await database.$disconnect();
      }
    },
  };
}

export type AuthRuntime = ReturnType<typeof createAuthRuntime>;
