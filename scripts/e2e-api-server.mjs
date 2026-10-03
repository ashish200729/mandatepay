import { createApp } from "../apps/api/dist/app.js";
import { PayPalClient, parsePayPalConfig } from "../packages/paypal/dist/index.js";
import { createE2ePayPalProvider } from "./e2e-paypal-provider.mjs";

if (
  process.env.NODE_ENV !== "test" ||
  process.env.PORT !== "4100" ||
  process.env.HOST !== "127.0.0.1" ||
  !process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test") ||
  process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
)
  throw new Error("The simulated provider server requires the isolated loopback E2E stack.");

const fixture = createE2ePayPalProvider();
const client = new PayPalClient(
  parsePayPalConfig({
    environment: "sandbox",
    clientId: "e2e-only-client",
    clientSecret: "e2e-only-secret",
    webhookId: "e2e-only-webhook",
  }),
  { fetch: fixture.transport },
);
const app = await createApp({ paypalClient: client });
app.get("/__e2e/paypal/return-url/:id", async (request, reply) => {
  const value = fixture.returnUrl(request.params.id);
  return value ? { url: value } : reply.status(404).send({ error: "Fixture order not found" });
});
app.get("/__e2e/paypal/counters", async () => fixture.counters);
await app.listen({ host: "127.0.0.1", port: 4100 });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
