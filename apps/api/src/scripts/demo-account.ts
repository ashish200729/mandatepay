import { CanonicalMandateSchema, type CanonicalMandate } from "@mandatepay/shared";
import { MandateStatus, type DatabaseClient, type MandateRepository } from "@mandatepay/database";
import { z } from "zod";
import type { AuthRuntime } from "../auth.js";
import { canonicalToCreateInput, mandateRepository } from "../services/mandates.js";

export const DEMO_MANDATE_REQUEST_KEY_PREFIX = "demo-account-mandate:";
export const DEMO_MANDATE_PROMPT =
  "Find Sony or Bose headphones. New only. Buy automatically up to $150 and ask me above that, never above $180.";
const DEMO_MANDATE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_NAME = "MandatePay Demo";
const FLAGS = new Set(["--reset-password", "--with-demo-mandate"]);
const COMMON_PASSWORD_FRAGMENTS = [
  "password",
  "passw0rd",
  "mandatepay",
  "123456",
  "qwerty",
  "letmein",
];

/** Operator-facing failure; its message never contains the configured password. */
export class DemoAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoAccountError";
  }
}

export interface DemoAccountOptions {
  email: string;
  password: string;
  name: string;
  resetPassword: boolean;
  withDemoMandate: boolean;
}

export interface DemoAccountResult {
  userId: string;
  email: string;
  created: boolean;
  passwordSet: boolean;
  emailVerified: true;
  autonomousPurchasingEnabled: boolean;
  mandate: { id: string; created: boolean } | null;
}

export interface DemoAccountDependencies {
  auth: AuthRuntime["auth"];
  database: DatabaseClient;
  mandates?: Pick<MandateRepository, "create" | "activate">;
}

/** Rejects passwords a judge-facing shared account should never use. */
export function assertStrongPassword(password: string, email: string): void {
  const problems: string[] = [];
  if (password.length < 12 || password.length > 128) problems.push("use 12 to 128 characters");
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes < 3) problems.push("mix at least three of lowercase, uppercase, digits and symbols");
  if (new Set(password).size < 6) problems.push("avoid repeated characters");
  const lower = password.toLowerCase();
  const localPart = email.split("@", 1)[0]?.toLowerCase() ?? "";
  if (
    COMMON_PASSWORD_FRAGMENTS.some((fragment) => lower.includes(fragment)) ||
    (localPart.length >= 3 && lower.includes(localPart))
  )
    problems.push("avoid common words and the email address");
  if (problems.length) {
    throw new DemoAccountError(`DEMO_ACCOUNT_PASSWORD is too weak: ${problems.join("; ")}.`);
  }
}

export function readDemoAccountOptions(
  environment: Record<string, string | undefined>,
  argv: readonly string[],
): DemoAccountOptions {
  const flags = argv.filter((argument) => argument !== "--");
  const unknown = flags.find((argument) => !FLAGS.has(argument));
  if (unknown !== undefined) {
    throw new DemoAccountError(
      "Unknown option. Supported options: --reset-password, --with-demo-mandate.",
    );
  }
  const email = z.email().safeParse(environment.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase() ?? "");
  if (!email.success) throw new DemoAccountError("Set DEMO_ACCOUNT_EMAIL to a valid email.");
  const password = environment.DEMO_ACCOUNT_PASSWORD ?? "";
  if (!password) throw new DemoAccountError("Set DEMO_ACCOUNT_PASSWORD.");
  assertStrongPassword(password, email.data);
  const name = environment.DEMO_ACCOUNT_NAME?.trim() || DEFAULT_NAME;
  if (name.length > 100)
    throw new DemoAccountError("DEMO_ACCOUNT_NAME must be 100 characters or fewer.");
  return {
    email: email.data,
    password,
    name,
    resetPassword: flags.includes("--reset-password"),
    withDemoMandate: flags.includes("--with-demo-mandate"),
  };
}

/** Canonical rules for the scripted demo: Sony/Bose headphones, new only, $150 auto / $180 cap. */
export function demoMandateRules(now: Date): CanonicalMandate {
  return CanonicalMandateSchema.parse({
    title: "Demo: Sony or Bose headphones",
    productIntent: "Sony or Bose headphones",
    currency: "USD",
    timezone: "UTC",
    allowedBrands: ["Sony", "Bose"],
    blockedBrands: [],
    allowedCategories: ["Headphones"],
    blockedCategories: [],
    allowedConditions: ["NEW"],
    autoSpendLimit: 15_000,
    transactionLimit: 18_000,
    quantityLimit: 1,
    allowedMerchants: [],
    blockedMerchants: [],
    newMerchantRequiresApproval: false,
    startsAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEMO_MANDATE_VALIDITY_MS).toISOString(),
  });
}

async function ensureDemoMandate(
  dependencies: DemoAccountDependencies,
  userId: string,
  now: Date,
): Promise<{ id: string; created: boolean }> {
  const existing = await dependencies.database.mandate.findFirst({
    where: {
      userId,
      status: MandateStatus.ACTIVE,
      expiresAt: { gt: now },
      creationRequestKey: { startsWith: DEMO_MANDATE_REQUEST_KEY_PREFIX },
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const mandates = dependencies.mandates ?? mandateRepository(dependencies.database);
  const draft = await mandates.create(
    canonicalToCreateInput(
      userId,
      DEMO_MANDATE_PROMPT,
      demoMandateRules(now),
      `${DEMO_MANDATE_REQUEST_KEY_PREFIX}${now.toISOString()}`,
    ),
  );
  const active = await mandates.activate(draft.id, userId, draft.version);
  return { id: active.id, created: true };
}

/**
 * Idempotently provisions a verified credential account through Better Auth, so password hashing
 * matches normal sign-up. Existing passwords change only with `resetPassword`. Autonomous
 * purchasing is never enabled here.
 */
export async function provisionDemoAccount(
  dependencies: DemoAccountDependencies,
  options: DemoAccountOptions,
  now = new Date(),
): Promise<DemoAccountResult> {
  const context = await dependencies.auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(options.email);
  let userId: string;
  let created = false;
  let passwordSet = false;

  if (!existing) {
    const result = await dependencies.auth.api.signUpEmail({
      body: { name: options.name, email: options.email, password: options.password },
    });
    userId = result.user.id;
    created = true;
    passwordSet = true;
    // Sign-up may auto-create a session nobody holds; remove it.
    await context.internalAdapter.deleteUserSessions(userId);
  } else {
    userId = existing.user.id;
    const current = await dependencies.database.user.findUnique({
      where: { id: userId },
      select: { disabledAt: true },
    });
    if (current?.disabledAt) {
      throw new DemoAccountError(
        "The demo account is disabled by an administrator. Re-enable it from the admin console first.",
      );
    }
    const credential = await context.internalAdapter.findCredentialAccount(userId);
    if (!credential || options.resetPassword) {
      const hash = await context.password.hash(options.password);
      if (credential) await context.internalAdapter.updatePassword(userId, hash);
      else
        await context.internalAdapter.createAccount({
          userId,
          providerId: "credential",
          accountId: userId,
          password: hash,
        });
      // Match Better Auth's reset behavior: a new password revokes existing sessions.
      await context.internalAdapter.deleteUserSessions(userId);
      passwordSet = true;
    }
  }

  const user = await dependencies.database.user.update({
    where: { id: userId },
    data: { emailVerified: true },
    select: { globalAutonomousPurchasingEnabled: true },
  });
  const mandate = options.withDemoMandate
    ? await ensureDemoMandate(dependencies, userId, now)
    : null;
  return {
    userId,
    email: options.email,
    created,
    passwordSet,
    emailVerified: true,
    autonomousPurchasingEnabled: user.globalAutonomousPurchasingEnabled,
    mandate,
  };
}

export function describeDemoAccountFailure(error: unknown): string {
  if (error instanceof DemoAccountError) return error.message;
  const code =
    typeof error === "object" && error !== null && "body" in error
      ? (error as { body?: { code?: unknown } }).body?.code
      : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)) {
    return `Better Auth rejected the demo account (${code}).`;
  }
  return "Demo account provisioning failed. Check DATABASE_URL, AUTH_SECRET and migrations.";
}
