import { createPrismaClient } from "@mandatepay/database";
import { createPayPalClientFromEnvironment } from "../services/payments.js";
import { PayPalWebhookRecoveryWorker } from "../services/webhook-recovery.js";

export async function runPayPalWebhookRecoveryOnce() {
  const paypal = createPayPalClientFromEnvironment({
    PAYPAL_ENV: process.env.PAYPAL_ENV,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID,
  });
  if (!paypal) throw new Error("PayPal Sandbox configuration is required for webhook recovery.");
  const database = createPrismaClient(process.env.DATABASE_URL);
  try {
    return await new PayPalWebhookRecoveryWorker(database, paypal).runOnce();
  } finally {
    await database.$disconnect();
  }
}

if (process.argv[1]?.endsWith("paypal-webhook-recovery.js")) {
  try {
    console.info(
      JSON.stringify({
        event: "webhook_recovery_completed",
        ...(await runPayPalWebhookRecoveryOnce()),
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: "webhook_recovery_failed" }));
    process.exitCode = 1;
  }
}
