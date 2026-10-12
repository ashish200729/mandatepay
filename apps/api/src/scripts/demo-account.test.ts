import { describe, expect, it, vi } from "vitest";
import {
  DemoAccountError,
  assertStrongPassword,
  demoMandateRules,
  describeDemoAccountFailure,
  provisionDemoAccount,
  readDemoAccountOptions,
  type DemoAccountDependencies,
  type DemoAccountOptions,
} from "./demo-account.js";

const password = "Sandbox-Ready_Review-42";
const options: DemoAccountOptions = {
  email: "judge@example.test",
  password,
  name: "MandatePay Demo",
  resetPassword: false,
  withDemoMandate: false,
};
const now = new Date("2026-10-12T00:00:00.000Z");

function fakes({
  existing = false,
  credential = true,
  disabled = false,
  activeMandate = false,
} = {}) {
  const internalAdapter = {
    findUserByEmail: vi.fn(async () =>
      existing ? { user: { id: "user-1" }, accounts: [] } : null,
    ),
    findCredentialAccount: vi.fn(async () => (credential ? { id: "account-1" } : null)),
    updatePassword: vi.fn(async () => undefined),
    createAccount: vi.fn(async () => ({ id: "account-2" })),
    deleteUserSessions: vi.fn(async () => undefined),
  };
  const passwordHasher = { hash: vi.fn(async (value: string) => `hashed:${value.length}`) };
  const signUpEmail = vi.fn(async () => ({ user: { id: "user-new" }, token: null }));
  const database = {
    user: {
      findUnique: vi.fn(async () => ({ disabledAt: disabled ? new Date() : null })),
      update: vi.fn(async () => ({ globalAutonomousPurchasingEnabled: false })),
    },
    mandate: {
      findFirst: vi.fn(async () => (activeMandate ? { id: "mandate-existing" } : null)),
    },
  };
  const mandates = {
    create: vi.fn(async () => ({ id: "mandate-new", version: 1 })),
    activate: vi.fn(async () => ({ id: "mandate-new" })),
  };
  const dependencies = {
    auth: {
      $context: Promise.resolve({ internalAdapter, password: passwordHasher }),
      api: { signUpEmail },
    },
    database,
    mandates,
  } as unknown as DemoAccountDependencies;
  return { dependencies, internalAdapter, passwordHasher, signUpEmail, database, mandates };
}

describe("demo account options", () => {
  it("reads normalized settings and supported flags", () => {
    expect(
      readDemoAccountOptions(
        { DEMO_ACCOUNT_EMAIL: " Judge@Example.TEST ", DEMO_ACCOUNT_PASSWORD: password },
        ["--", "--with-demo-mandate"],
      ),
    ).toEqual({ ...options, withDemoMandate: true });
    expect(
      readDemoAccountOptions(
        {
          DEMO_ACCOUNT_EMAIL: "judge@example.test",
          DEMO_ACCOUNT_PASSWORD: password,
          DEMO_ACCOUNT_NAME: " Judges ",
        },
        ["--reset-password"],
      ),
    ).toMatchObject({ name: "Judges", resetPassword: true, withDemoMandate: false });
  });

  it("rejects missing settings and unknown flags without echoing the password", () => {
    const attempts: Array<[Record<string, string>, string[]]> = [
      [{ DEMO_ACCOUNT_PASSWORD: password }, []],
      [{ DEMO_ACCOUNT_EMAIL: "not-an-email", DEMO_ACCOUNT_PASSWORD: password }, []],
      [{ DEMO_ACCOUNT_EMAIL: "judge@example.test" }, []],
      [{ DEMO_ACCOUNT_EMAIL: "judge@example.test", DEMO_ACCOUNT_PASSWORD: password }, ["--force"]],
    ];
    for (const [environment, argv] of attempts) {
      let message = "";
      try {
        readDemoAccountOptions(environment, argv);
      } catch (error) {
        expect(error).toBeInstanceOf(DemoAccountError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(password);
    }
  });

  it("rejects weak passwords", () => {
    for (const weak of [
      "Short-1a",
      "alllowercaseletters",
      "Aaaaaaaaaaaa1!",
      "My-Password-2026",
      "Judge-2026-Sandbox!",
      "x".repeat(129),
    ]) {
      expect(() => assertStrongPassword(weak, "judge@example.test")).toThrow(DemoAccountError);
    }
    expect(() => assertStrongPassword(password, "operator@example.test")).not.toThrow();
  });
});

describe("demo account provisioning", () => {
  it("creates a verified account through Better Auth sign-up with autonomy off", async () => {
    const { dependencies, signUpEmail, internalAdapter, database } = fakes();

    const result = await provisionDemoAccount(dependencies, options, now);

    expect(signUpEmail).toHaveBeenCalledWith({
      body: { name: "MandatePay Demo", email: "judge@example.test", password },
    });
    expect(internalAdapter.deleteUserSessions).toHaveBeenCalledWith("user-new");
    expect(database.user.update).toHaveBeenCalledWith({
      where: { id: "user-new" },
      data: { emailVerified: true },
      select: { globalAutonomousPurchasingEnabled: true },
    });
    expect(result).toEqual({
      userId: "user-new",
      email: "judge@example.test",
      created: true,
      passwordSet: true,
      emailVerified: true,
      autonomousPurchasingEnabled: false,
      mandate: null,
    });
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("is idempotent for an existing account and changes its password only with the flag", async () => {
    const unchanged = fakes({ existing: true });
    const result = await provisionDemoAccount(unchanged.dependencies, options, now);
    expect(result).toMatchObject({ userId: "user-1", created: false, passwordSet: false });
    expect(unchanged.signUpEmail).not.toHaveBeenCalled();
    expect(unchanged.internalAdapter.updatePassword).not.toHaveBeenCalled();
    expect(unchanged.internalAdapter.deleteUserSessions).not.toHaveBeenCalled();

    const reset = fakes({ existing: true });
    await provisionDemoAccount(reset.dependencies, { ...options, resetPassword: true }, now);
    expect(reset.passwordHasher.hash).toHaveBeenCalledWith(password);
    expect(reset.internalAdapter.updatePassword).toHaveBeenCalledWith(
      "user-1",
      `hashed:${password.length}`,
    );
    expect(reset.internalAdapter.deleteUserSessions).toHaveBeenCalledWith("user-1");
  });

  it("adds a credential to an existing passwordless user such as the seed account", async () => {
    const { dependencies, internalAdapter } = fakes({ existing: true, credential: false });

    const result = await provisionDemoAccount(dependencies, options, now);

    expect(internalAdapter.createAccount).toHaveBeenCalledWith({
      userId: "user-1",
      providerId: "credential",
      accountId: "user-1",
      password: `hashed:${password.length}`,
    });
    expect(result.passwordSet).toBe(true);
  });

  it("refuses to modify an account an administrator disabled", async () => {
    const { dependencies, database, internalAdapter } = fakes({ existing: true, disabled: true });

    await expect(
      provisionDemoAccount(dependencies, { ...options, resetPassword: true }, now),
    ).rejects.toThrow(DemoAccountError);
    expect(internalAdapter.updatePassword).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
  });

  it("creates and activates the canonical demo mandate once", async () => {
    const created = fakes({ existing: true });
    const result = await provisionDemoAccount(
      created.dependencies,
      { ...options, withDemoMandate: true },
      now,
    );
    expect(result.mandate).toEqual({ id: "mandate-new", created: true });
    const [input] = created.mandates.create.mock.calls[0] as unknown as [
      {
        userId: string;
        currency: string;
        autoSpendLimit: bigint;
        transactionLimit: bigint;
        creationRequestKey: string;
        canonicalRules: Record<string, unknown>;
      },
    ];
    expect(input).toMatchObject({
      userId: "user-1",
      currency: "USD",
      autoSpendLimit: 15_000n,
      transactionLimit: 18_000n,
      creationRequestKey: "demo-account-mandate:2026-10-12T00:00:00.000Z",
    });
    expect(input.canonicalRules).toMatchObject({
      allowedBrands: ["Sony", "Bose"],
      allowedCategories: ["Headphones"],
      allowedConditions: ["NEW"],
      newMerchantRequiresApproval: false,
    });
    expect(created.mandates.activate).toHaveBeenCalledWith("mandate-new", "user-1", 1);

    const existing = fakes({ existing: true, activeMandate: true });
    const again = await provisionDemoAccount(
      existing.dependencies,
      { ...options, withDemoMandate: true },
      now,
    );
    expect(again.mandate).toEqual({ id: "mandate-existing", created: false });
    expect(existing.mandates.create).not.toHaveBeenCalled();
  });

  it("builds valid demo rules within the automatic and transaction limits", () => {
    const rules = demoMandateRules(now);
    expect(rules.autoSpendLimit).toBe(15_000);
    expect(rules.transactionLimit).toBe(18_000);
    expect(rules.currency).toBe("USD");
    expect(Date.parse(rules.expiresAt!) - Date.parse(rules.startsAt!)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("describes failures without leaking unexpected error details", () => {
    expect(describeDemoAccountFailure(new DemoAccountError("Set DEMO_ACCOUNT_EMAIL."))).toBe(
      "Set DEMO_ACCOUNT_EMAIL.",
    );
    expect(describeDemoAccountFailure({ body: { code: "PASSWORD_TOO_LONG" } })).toContain(
      "PASSWORD_TOO_LONG",
    );
    expect(
      describeDemoAccountFailure(new Error(`connect failed postgresql://user:${password}@db`)),
    ).not.toContain(password);
  });
});
