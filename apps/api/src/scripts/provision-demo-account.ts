// Operator command: pnpm --filter @mandatepay/api demo:account [--reset-password] [--with-demo-mandate]
// Reads DEMO_ACCOUNT_EMAIL, DEMO_ACCOUNT_PASSWORD and optional DEMO_ACCOUNT_NAME. Never prints
// the password and sends no email: the account is marked verified directly.
import { createAuthRuntime } from "../auth.js";
import { env } from "../env.js";
import {
  DemoAccountError,
  describeDemoAccountFailure,
  provisionDemoAccount,
  readDemoAccountOptions,
} from "./demo-account.js";

async function main() {
  const options = readDemoAccountOptions(process.env, process.argv.slice(2));
  if (!env.DATABASE_URL || !env.AUTH_SECRET) {
    throw new DemoAccountError("DATABASE_URL and AUTH_SECRET are required.");
  }
  const runtime = createAuthRuntime({
    databaseUrl: env.DATABASE_URL,
    authSecret: env.AUTH_SECRET,
    appUrl: env.APP_URL,
    adminOrigin: env.ADMIN_ORIGIN,
    nodeEnv: env.NODE_ENV,
    requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
    // Verification is applied directly; no message is sent to the demo address.
    emailSender: async () => undefined,
  });
  try {
    const result = await provisionDemoAccount(runtime, options);
    console.info(JSON.stringify(result));
  } finally {
    await runtime.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(describeDemoAccountFailure(error));
  process.exitCode = 1;
}
