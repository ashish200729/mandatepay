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
const { createPrismaClient, AdminRepository, MandateRepository, ProposalRepository } =
  await import("../packages/database/dist/src/index.js");
const { createAuthRuntime } = await import("../apps/api/dist/auth.js");
const { createApp } = await import("../apps/api/dist/app.js");
const database = createPrismaClient(process.env.DATABASE_URL);
function money(minor) {
  return { currency_code: "USD", value: (Number(minor) / 100).toFixed(2) };
}
const paypalClient = {
  config: { webhookId: "admin-e2e-webhook" },
  async getOrder(id) {
    const payment = await database.payment.findUnique({
      where: { paypalOrderId: id },
    });
    if (!payment) throw Object.assign(new Error("missing order"), { unknownOutcome: true });
    const capture = payment.paypalCaptureId
      ? {
          id: payment.paypalCaptureId,
          status: "COMPLETED",
          amount: money(payment.amount),
          custom_id: payment.proposalId,
          create_time: "2026-10-06T12:00:00Z",
        }
      : null;
    return {
      id,
      status: payment.paypalCaptureId ? "COMPLETED" : "APPROVED",
      links: [],
      purchase_units: [
        {
          reference_id: payment.id,
          custom_id: payment.proposalId,
          amount: money(payment.amount),
          ...(capture ? { payments: { captures: [capture] } } : {}),
        },
      ],
      approvalUrl: "https://sandbox.paypal.com/checkoutnow?token=" + id,
    };
  },
  async getCapture(id) {
    const payment = await database.payment.findUnique({ where: { paypalCaptureId: id } });
    if (!payment) throw Object.assign(new Error("missing capture"), { unknownOutcome: true });
    return {
      id,
      status: "COMPLETED",
      amount: money(payment.amount),
      custom_id: payment.proposalId,
      create_time: "2026-10-06T12:00:00Z",
      supplementary_data: payment.paypalOrderId
        ? { related_ids: { order_id: payment.paypalOrderId } }
        : undefined,
    };
  },
  async getRefund(id) {
    const refund = await database.refund.findFirst({
      where: { OR: [{ paypalRefundId: id }, { id: id.replace(/^REFUND-E2E-/, "") }] },
    });
    if (!refund) throw Object.assign(new Error("missing refund"), { unknownOutcome: true });
    return {
      id: refund.paypalRefundId ?? id,
      status: refund.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      amount: money(refund.amount),
      invoice_id: refund.id,
      create_time: "2026-10-06T12:05:00Z",
    };
  },
  async refundCapture(input) {
    return {
      id: "REFUND-E2E-" + input.invoiceId,
      status: "COMPLETED",
      amount: money(input.amountMinor),
      invoice_id: input.invoiceId,
      capture_id: input.captureId,
      create_time: "2026-10-06T12:05:00Z",
    };
  },
};
await database.adminActionRequest.deleteMany();
await database.platformSetting.deleteMany();
await database.adminPrincipal.deleteMany();
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
  testAdminReadMaximum: 2000,
  testAdminMutationMaximum: 100,
  testAdminFinancialMaximum: 50,
  paypalClient,
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
  originalPrompt: "secret-original-prompt-must-not-render",
  webhookSecret: "webhook-secret-must-not-render",
  ownerUserId: "",
  mandateId: "",
  proposalId: "",
  proposedProposalId: "",
  approvalId: "",
  paymentId: "",
  pendingPaymentId: "",
  refundId: "",
  webhookId: "",
  retryWebhookId: "",
};
let principal;
let next;
let stopping = false;
async function cleanup() {
  await database.refund.deleteMany({ where: { userId: { in: userIds } } });
  await database.webhookInbox.deleteMany({
    where: { providerEventId: { startsWith: "admin-ops-browser-" } },
  });
  await database.payment.deleteMany({ where: { userId: { in: userIds } } });
  await database.approval.deleteMany({ where: { userId: { in: userIds } } });
  await database.spendReservation.deleteMany({
    where: { mandate: { userId: { in: userIds } } },
  });
  await database.adminActionRequest.deleteMany();
  await database.platformSetting.deleteMany();
  await database.adminPrincipal.deleteMany();
  await database.session.deleteMany({ where: { userId: { in: userIds } } });
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
  const ownerUserId = userIds[1];
  fixture.ownerUserId = ownerUserId;
  await database.user.update({
    where: { id: ownerUserId },
    data: { globalAutonomousPurchasingEnabled: true },
  });
  const mandate = await new MandateRepository(database).create({
    userId: ownerUserId,
    title: "Browser operations headphones",
    originalPrompt: fixture.originalPrompt,
    status: "ACTIVE",
    autoSpendLimit: 15_000n,
    transactionLimit: 18_000n,
    dailyLimit: 20_000n,
    startsAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    rules: [{ ruleType: "ALLOWED_BRAND", operator: "IN", value: ["Sony"] }],
  });
  fixture.mandateId = mandate.id;
  const product = await database.productSnapshot.create({
    data: {
      source: "admin-ops-browser",
      externalId: `headphones-${randomUUID()}`,
      title: "Browser operations headphones",
      brand: "Sony",
      category: "headphones",
      condition: "NEW",
      price: 10_000n,
      currency: "USD",
      merchant: "Test merchant",
      metadata: { token: fixture.webhookSecret },
    },
  });
  const proposal = await new ProposalRepository(database).create({
    userId: ownerUserId,
    mandateId: mandate.id,
    mandateVersionId: mandate.activeVersionId ?? "",
    productSnapshotId: product.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `admin-ops-browser-proposal-${randomUUID()}`,
  });
  fixture.proposalId = proposal.id;
  const proposed = await new ProposalRepository(database).create({
    userId: ownerUserId,
    mandateId: mandate.id,
    mandateVersionId: mandate.activeVersionId ?? "",
    productSnapshotId: product.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `admin-ops-browser-proposed-${randomUUID()}`,
  });
  fixture.proposedProposalId = proposed.id;
  await database.policyDecision.create({
    data: {
      proposalId: proposal.id,
      mandateVersionId: mandate.activeVersionId ?? "",
      decision: "REQUIRE_APPROVAL",
      reasonCodes: ["AUTO_SPEND_THRESHOLD_EXCEEDED"],
      rulesSnapshot: {},
      spendSnapshot: {},
    },
  });
  const approval = await database.approval.create({
    data: {
      proposalId: proposal.id,
      userId: ownerUserId,
      decision: "APPROVED",
      proposalFingerprint: proposal.proposalFingerprint,
      expiresAt: new Date(Date.now() + 86_400_000),
      decidedAt: new Date(),
    },
  });
  fixture.approvalId = approval.id;
  const paypalOrderId = `ORDER-ADMIN-OPS-${randomUUID()}`;
  const paypalCaptureId = `CAPTURE-ADMIN-OPS-${randomUUID()}`;
  const payment = await database.payment.create({
    data: {
      userId: ownerUserId,
      mandateId: mandate.id,
      proposalId: proposal.id,
      paypalOrderId,
      paypalCaptureId,
      amount: 10_000n,
      currency: "USD",
      status: "PARTIALLY_REFUNDED",
      idempotencyKey: `admin-ops-browser-payment-${randomUUID()}`,
      capturedAt: new Date(),
    },
  });
  fixture.paymentId = payment.id;
  await database.purchaseProposal.update({
    where: { id: proposal.id },
    data: { status: "COMPLETED" },
  });
  const refund = await database.refund.create({
    data: {
      paymentId: payment.id,
      userId: ownerUserId,
      amount: 2_000n,
      currency: "USD",
      status: "COMPLETED",
      paypalRefundId: `REFUND-ADMIN-OPS-${randomUUID()}`,
      idempotencyKey: `admin-ops-browser-refund-${randomUUID()}`,
      settledAt: new Date(),
      reason: "Partial customer return.",
    },
  });
  fixture.refundId = refund.id;
  const pendingProposal = await new ProposalRepository(database).create({
    userId: ownerUserId,
    mandateId: mandate.id,
    mandateVersionId: mandate.activeVersionId ?? "",
    productSnapshotId: product.id,
    quantity: 1,
    shipping: 0n,
    tax: 0n,
    idempotencyKey: `admin-ops-browser-pending-${randomUUID()}`,
  });
  const pendingOrderId = `ORDER-ADMIN-OPS-PENDING-${randomUUID()}`;
  const pendingPayment = await database.payment.create({
    data: {
      userId: ownerUserId,
      mandateId: mandate.id,
      proposalId: pendingProposal.id,
      paypalOrderId: pendingOrderId,
      amount: 10_000n,
      currency: "USD",
      status: "CREATED",
      idempotencyKey: `admin-ops-browser-pending-pay-${randomUUID()}`,
    },
  });
  fixture.pendingPaymentId = pendingPayment.id;
  const webhook = await database.webhookInbox.create({
    data: {
      provider: "paypal",
      providerEventId: `admin-ops-browser-${randomUUID()}`,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      signatureVerified: true,
      payload: {
        resource: {
          id: paypalCaptureId,
          supplementary_data: { related_ids: { order_id: paypalOrderId } },
          secret: fixture.webhookSecret,
        },
      },
      status: "PROCESSED",
      attempts: 1,
      processedAt: new Date(),
    },
  });
  fixture.webhookId = webhook.id;
  const retryWebhook = await database.webhookInbox.create({
    data: {
      provider: "paypal",
      providerEventId: `admin-ops-browser-retry-${randomUUID()}`,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      signatureVerified: true,
      payload: {
        id: `EVT-ADMIN-OPS-${randomUUID()}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: paypalCaptureId,
          supplementary_data: { related_ids: { order_id: paypalOrderId } },
        },
      },
      status: "FAILED",
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1_000),
    },
  });
  fixture.retryWebhookId = retryWebhook.id;
  await database.auditEvent.create({
    data: {
      userId: ownerUserId,
      eventType: "PAYMENT_CAPTURED",
      entityType: "PAYMENT",
      entityId: payment.id,
      payload: { amountMinor: 10000, token: fixture.webhookSecret },
    },
  });
  app.get("/__admin_fixture", async () => fixture);
  let fixtureSessionSequence = 1;
  app.post("/__admin_fixture/session", async (_request, reply) => {
    // Authenticate the synthetic account through the real guard on an isolated
    // fixture IP, without weakening production rate limits for browser tests.
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/session",
      remoteAddress: `10.43.0.${fixtureSessionSequence++}`,
      headers: { origin: adminOrigin, "content-type": "application/json" },
      payload: JSON.stringify({ email: fixture.adminEmail, password: fixture.password }),
    });
    if (response.statusCode !== 200) return reply.status(503).send({ ok: false });
    reply.header("set-cookie", response.headers["set-cookie"]);
    return { ok: true };
  });
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
      env: {
        ...process.env,
        NODE_ENV: "production",
        ADMIN_ENVIRONMENT: "test",
        ADMIN_UI_FIXTURES: "1",
      },
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
