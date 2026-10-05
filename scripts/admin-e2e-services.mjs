import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadE2eEnvironment } from "./e2e-environment.mjs";

const isolated = loadE2eEnvironment();
const adminOrigin = "http://127.0.0.1:3121";
const apiUrl = "http://127.0.0.1:4121";
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: isolated.TEST_DATABASE_URL,
  TEST_DATABASE_URL: isolated.TEST_DATABASE_URL,
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  APP_URL: "http://127.0.0.1:3100",
  API_URL: apiUrl,
  ADMIN_ORIGIN: adminOrigin,
  OPENAI_API_KEY: "",
  CHANNEL3_API_KEY: "",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  RESEND_API_KEY: "",
  AUTH_EMAIL_FROM: "",
});
// This fixture server is never imported by the production API or admin app.
if (
  process.env.DATABASE_URL !== isolated.TEST_DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Admin browser tests require the isolated test database.");
const { createPrismaClient, AdminRepository } =
  await import("../packages/database/dist/src/index.js");
const { createAuthRuntime } = await import("../apps/api/dist/auth.js");
const { createApp } = await import("../apps/api/dist/app.js");
const database = createPrismaClient(process.env.DATABASE_URL);
if (await database.adminPrincipal.count()) {
  await database.$disconnect();
  throw new Error(
    "Admin browser fixtures require no existing main principal in the test database.",
  );
}
const runtime = createAuthRuntime({
  database,
  databaseUrl: process.env.DATABASE_URL,
  authSecret: process.env.AUTH_SECRET,
  appUrl: process.env.APP_URL,
  adminOrigin,
  nodeEnv: "test",
  testRateLimitMaximum: 500,
});
const app = await createApp({
  authRuntime: runtime,
  config: {
    HOST: "127.0.0.1",
    PORT: 4121,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    WEB_ORIGIN: process.env.APP_URL,
    APP_URL: process.env.APP_URL,
    API_URL: apiUrl,
    ADMIN_ORIGIN: adminOrigin,
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PAYPAL_ENV: "sandbox",
    PRODUCT_DISCOVERY_MODE: "demo",
  },
});
const userIds = [];
const fixture = {
  adminEmail: `admin-browser-${randomUUID()}@mandatepay.local`,
  normalEmail: `normal-browser-${randomUUID()}@mandatepay.local`,
  password: "browser-fixture-only-password123!",
};
let principal;
let next;
let stopping = false;
async function cleanup() {
  await database.adminPrincipal.deleteMany({ where: { userId: { in: userIds } } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  next?.kill("SIGTERM");
  await app.close();
  await cleanup();
  await database.$disconnect();
  process.exitCode = code;
  // Better Auth's memory-store timers otherwise keep the fixture process alive.
  setTimeout(() => process.exit(code), 100).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown());
try {
  for (const email of [fixture.adminEmail, fixture.normalEmail]) {
    const response = await runtime.auth.handler(
      new Request(`${process.env.APP_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: process.env.APP_URL,
          "content-type": "application/json",
          "x-mandatepay-client-ip": "127.0.0.1",
        },
        body: JSON.stringify({ email, password: fixture.password, name: "Browser fixture" }),
      }),
    );
    if (response.status !== 200) throw new Error("Could not provision browser fixture.");
    const userId = (await response.json()).user.id;
    userIds.push(userId);
    await database.user.update({ where: { id: userId }, data: { emailVerified: true } });
  }
  principal = (await new AdminRepository(database).bootstrap(userIds[0])).principal;
  app.get("/__admin_fixture", async () => fixture);
  app.post("/__admin_fixture/cleanup", async () => {
    await cleanup();
    stopping = true;
    next?.kill("SIGTERM");
    await database.$disconnect();
    // Exit after delivering the cleanup response, including on Windows where
    // Playwright cannot deliver POSIX shutdown signals to the service tree.
    setTimeout(() => process.exit(0), 250);
    return { ok: true };
  });
  app.post("/__admin_fixture/state", async (request, reply) => {
    const action = request.body?.action;
    if (action === "inactive" || action === "active") {
      await database.adminPrincipal.update({
        where: { id: principal.id },
        data: { active: action === "active" },
      });
    } else if (action === "idle") {
      await database.adminSessionSecurity.updateMany({
        where: { principalId: principal.id },
        data: { lastSeenAt: new Date(Date.now() - 30 * 60_000) },
      });
    } else return reply.status(400).send();
    return { ok: true };
  });
  await app.listen({ host: "127.0.0.1", port: 4121 });
  next = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3121"],
    {
      cwd: fileURLToPath(new URL("../apps/admin/", import.meta.url)),
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  next.once("error", () => void shutdown(1));
  next.once("exit", (code) => {
    if (!stopping) void shutdown(code || 1);
  });
} catch (error) {
  await shutdown(1);
  throw error;
}
