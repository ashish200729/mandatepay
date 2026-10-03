import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client.js";
import {
  ApprovalDecision,
  AuditEntityType,
  AuditEventType,
  MandateRuleType,
  MandateStatus,
  PolicyDecisionType,
  ProductCondition,
  ProposalStatus,
  ReservationStatus,
  ReservationWindow,
} from "../src/generated/prisma/enums.js";
import { proposalFingerprint } from "../src/fingerprint.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the demo seed.");
}

const adapter = new PrismaPg({ connectionString });
const db = new PrismaClient({ adapter });

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  mandate: "00000000-0000-4000-8000-000000000010",
  version: "00000000-0000-4000-8000-000000000011",
  allowProduct: "00000000-0000-4000-8000-000000000020",
  approvalProduct: "00000000-0000-4000-8000-000000000021",
  blockedProduct: "00000000-0000-4000-8000-000000000022",
  allowProposal: "00000000-0000-4000-8000-000000000030",
  approvalProposal: "00000000-0000-4000-8000-000000000031",
  blockedProposal: "00000000-0000-4000-8000-000000000032",
  allowDecision: "00000000-0000-4000-8000-000000000040",
  approvalDecision: "00000000-0000-4000-8000-000000000041",
  blockedDecision: "00000000-0000-4000-8000-000000000042",
  approval: "00000000-0000-4000-8000-000000000050",
  payment: "00000000-0000-4000-8000-000000000060",
  reservation: "00000000-0000-4000-8000-000000000070",
} as const;

const now = new Date();
const startsAt = new Date("2026-01-01T00:00:00.000Z");
const expiresAt = new Date("2099-01-01T00:00:00.000Z");
const sampleCurrency = "USD";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function main(): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { id: ids.user },
      create: {
        id: ids.user,
        email: "demo@mandatepay.local",
        name: "MandatePay Demo",
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
      },
      update: {
        email: "demo@mandatepay.local",
        name: "MandatePay Demo",
        emailVerified: true,
        globalAutonomousPurchasingEnabled: true,
      },
    });

    await tx.mandate.upsert({
      where: { id: ids.mandate },
      create: {
        id: ids.mandate,
        userId: ids.user,
        title: "Headphones under control",
        originalPrompt:
          "Find Sony or Bose noise-cancelling headphones. New only. Auto-buy below $150 and ask above that.",
        status: MandateStatus.ACTIVE,
        currency: sampleCurrency,
        autoSpendLimit: 15_000n,
        transactionLimit: 18_000n,
        dailyLimit: 20_000n,
        weeklyLimit: 50_000n,
        monthlyLimit: 100_000n,
        spendTimeZone: "UTC",
        startsAt,
        expiresAt,
        version: 1,
      },
      update: {
        status: MandateStatus.ACTIVE,
        activeVersionId: ids.version,
      },
    });

    const existingVersion = await tx.mandateVersion.findUnique({ where: { id: ids.version } });
    if (!existingVersion) {
      await tx.mandateVersion.create({
        data: {
          id: ids.version,
          mandateId: ids.mandate,
          version: 1,
          title: "Headphones under control",
          originalPrompt:
            "Find Sony or Bose noise-cancelling headphones. New only. Auto-buy below $150 and ask above that.",
          currency: sampleCurrency,
          autoSpendLimit: 15_000n,
          transactionLimit: 18_000n,
          dailyLimit: 20_000n,
          weeklyLimit: 50_000n,
          monthlyLimit: 100_000n,
          spendTimeZone: "UTC",
          startsAt,
          expiresAt,
          canonicalRules: json({
            title: "Headphones under control",
            productIntent: "noise-cancelling headphones",
            currency: sampleCurrency,
            timezone: "UTC",
            allowedBrands: ["Sony", "Bose"],
            blockedBrands: [],
            allowedCategories: [],
            blockedCategories: [],
            allowedConditions: ["NEW"],
            autoSpendLimit: 15_000,
            transactionLimit: 18_000,
            dailyLimit: 20_000,
            weeklyLimit: 50_000,
            monthlyLimit: 100_000,
            quantityLimit: 1,
            allowedMerchants: [],
            blockedMerchants: [],
            newMerchantRequiresApproval: false,
            startsAt: startsAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          }),
        },
      });
    }

    await tx.mandate.update({
      where: { id: ids.mandate },
      data: {
        activeVersionId: ids.version,
        status: MandateStatus.ACTIVE,
        version: 1,
      },
    });

    if (
      !(await tx.mandateRule.findUnique({ where: { id: "00000000-0000-4000-8000-000000000012" } }))
    ) {
      await tx.mandateRule.create({
        data: {
          id: "00000000-0000-4000-8000-000000000012",
          mandateId: ids.mandate,
          mandateVersionId: ids.version,
          ruleType: MandateRuleType.ALLOWED_BRAND,
          operator: "IN",
          value: json(["Sony", "Bose"]),
        },
      });
    }
    if (
      !(await tx.mandateRule.findUnique({ where: { id: "00000000-0000-4000-8000-000000000013" } }))
    ) {
      await tx.mandateRule.create({
        data: {
          id: "00000000-0000-4000-8000-000000000013",
          mandateId: ids.mandate,
          mandateVersionId: ids.version,
          ruleType: MandateRuleType.REQUIRED_CONDITION,
          operator: "EQUALS",
          value: json("NEW"),
        },
      });
    }

    const products = [
      {
        id: ids.allowProduct,
        externalId: "demo-headphones-139",
        title: "Sony WH-1000XM5 — Sample ALLOW",
        brand: "Sony",
        price: 13_900n,
        condition: ProductCondition.NEW,
      },
      {
        id: ids.approvalProduct,
        externalId: "demo-headphones-169",
        title: "Sony WH-1000XM5 — Sample APPROVAL",
        brand: "Sony",
        price: 16_900n,
        condition: ProductCondition.NEW,
      },
      {
        id: ids.blockedProduct,
        externalId: "demo-headphones-refurbished",
        title: "Bose QuietComfort — Sample BLOCK",
        brand: "Bose",
        price: 12_000n,
        condition: ProductCondition.REFURBISHED,
      },
    ] as const;

    for (const product of products) {
      const existingProduct = await tx.productSnapshot.findUnique({
        where: { source_externalId: { source: "demo", externalId: product.externalId } },
      });
      if (!existingProduct) {
        await tx.productSnapshot.create({
          data: {
            id: product.id,
            source: "demo",
            externalId: product.externalId,
            title: product.title,
            brand: product.brand,
            category: "headphones",
            condition: product.condition,
            price: product.price,
            currency: sampleCurrency,
            merchant: "MandatePay Demo Store",
            metadata: json({ sample: true, source: "seed", productScenario: product.condition }),
            capturedAt: now,
          },
        });
      }
    }

    const proposalSpecs = [
      {
        id: ids.allowProposal,
        productId: ids.allowProduct,
        amount: 13_900n,
        status: ProposalStatus.COMPLETED,
        idempotencyKey: "sample-allow-proposal-v1",
        fingerprint: proposalFingerprint({
          userId: ids.user,
          mandateId: ids.mandate,
          mandateVersionId: ids.version,
          productSnapshotId: ids.allowProduct,
          quantity: 1,
          subtotal: 13_900n,
          shipping: 0n,
          tax: 0n,
          total: 13_900n,
          currency: sampleCurrency,
        }),
      },
      {
        id: ids.approvalProposal,
        productId: ids.approvalProduct,
        amount: 16_900n,
        status: ProposalStatus.AWAITING_APPROVAL,
        idempotencyKey: "sample-approval-proposal-v1",
        fingerprint: proposalFingerprint({
          userId: ids.user,
          mandateId: ids.mandate,
          mandateVersionId: ids.version,
          productSnapshotId: ids.approvalProduct,
          quantity: 1,
          subtotal: 16_900n,
          shipping: 0n,
          tax: 0n,
          total: 16_900n,
          currency: sampleCurrency,
        }),
      },
      {
        id: ids.blockedProposal,
        productId: ids.blockedProduct,
        amount: 12_000n,
        status: ProposalStatus.BLOCKED,
        idempotencyKey: "sample-blocked-proposal-v1",
        fingerprint: proposalFingerprint({
          userId: ids.user,
          mandateId: ids.mandate,
          mandateVersionId: ids.version,
          productSnapshotId: ids.blockedProduct,
          quantity: 1,
          subtotal: 12_000n,
          shipping: 0n,
          tax: 0n,
          total: 12_000n,
          currency: sampleCurrency,
        }),
      },
    ] as const;

    for (const proposal of proposalSpecs) {
      if (!(await tx.purchaseProposal.findUnique({ where: { id: proposal.id } }))) {
        await tx.purchaseProposal.create({
          data: {
            id: proposal.id,
            userId: ids.user,
            mandateId: ids.mandate,
            mandateVersionId: ids.version,
            productSnapshotId: proposal.productId,
            quantity: 1,
            subtotal: proposal.amount,
            shipping: 0n,
            tax: 0n,
            total: proposal.amount,
            currency: sampleCurrency,
            status: proposal.status,
            proposalFingerprint: proposal.fingerprint,
            idempotencyKey: proposal.idempotencyKey,
            isSample: true,
          },
        });
      }
    }

    if (!(await tx.policyDecision.findUnique({ where: { id: ids.allowDecision } }))) {
      await tx.policyDecision.create({
        data: {
          id: ids.allowDecision,
          proposalId: ids.allowProposal,
          mandateVersionId: ids.version,
          decision: PolicyDecisionType.ALLOW,
          reasonCodes: json(["WITHIN_AUTONOMOUS_LIMIT"]),
          rulesSnapshot: json({ autoSpendLimit: "15000", transactionLimit: "18000" }),
          spendSnapshot: json({ dailySpend: "0", currency: sampleCurrency }),
        },
      });
    }
    if (!(await tx.policyDecision.findUnique({ where: { id: ids.approvalDecision } }))) {
      await tx.policyDecision.create({
        data: {
          id: ids.approvalDecision,
          proposalId: ids.approvalProposal,
          mandateVersionId: ids.version,
          decision: PolicyDecisionType.REQUIRE_APPROVAL,
          reasonCodes: json(["AUTO_SPEND_THRESHOLD_EXCEEDED"]),
          rulesSnapshot: json({ autoSpendLimit: "15000", transactionLimit: "18000" }),
          spendSnapshot: json({ dailySpend: "0", currency: sampleCurrency }),
        },
      });
    }
    if (!(await tx.policyDecision.findUnique({ where: { id: ids.blockedDecision } }))) {
      await tx.policyDecision.create({
        data: {
          id: ids.blockedDecision,
          proposalId: ids.blockedProposal,
          mandateVersionId: ids.version,
          decision: PolicyDecisionType.BLOCK,
          reasonCodes: json(["CONDITION_NOT_ALLOWED"]),
          rulesSnapshot: json({ requiredCondition: "NEW" }),
          spendSnapshot: json({ dailySpend: "0", currency: sampleCurrency }),
        },
      });
    }

    await tx.approval.upsert({
      where: { proposalId: ids.approvalProposal },
      create: {
        id: ids.approval,
        proposalId: ids.approvalProposal,
        userId: ids.user,
        decision: ApprovalDecision.PENDING,
        proposalFingerprint: proposalSpecs[1].fingerprint,
        expiresAt: new Date(now.getTime() + 86_400_000),
        isSample: true,
      },
      update: {
        decision: ApprovalDecision.PENDING,
        proposalFingerprint: proposalSpecs[1].fingerprint,
        expiresAt: new Date(now.getTime() + 86_400_000),
        isSample: true,
      },
    });

    await tx.payment.upsert({
      where: { id: ids.payment },
      create: {
        id: ids.payment,
        userId: ids.user,
        mandateId: ids.mandate,
        proposalId: ids.allowProposal,
        paypalOrderId: "sample-paypal-order-allow",
        paypalCaptureId: "sample-paypal-capture-allow",
        amount: 13_900n,
        currency: sampleCurrency,
        status: "COMPLETED",
        idempotencyKey: "sample-allow-payment-v1",
        isSample: true,
        capturedAt: now,
      },
      update: {
        status: "COMPLETED",
        paypalOrderId: "sample-paypal-order-allow",
        paypalCaptureId: "sample-paypal-capture-allow",
        isSample: true,
        capturedAt: now,
      },
    });

    await tx.spendReservation.upsert({
      where: { proposalId: ids.allowProposal },
      create: {
        id: ids.reservation,
        mandateId: ids.mandate,
        mandateVersionId: ids.version,
        proposalId: ids.allowProposal,
        amount: 13_900n,
        currency: sampleCurrency,
        window: ReservationWindow.DAILY,
        windowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        windowEnd: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
        ),
        status: ReservationStatus.CONSUMED,
        isSample: true,
        expiresAt: now,
        consumedAt: now,
      },
      update: { status: ReservationStatus.CONSUMED, isSample: true, consumedAt: now },
    });

    const auditEvents = [
      [
        "sample-audit-allow",
        AuditEventType.POLICY_ALLOWED,
        AuditEntityType.PURCHASE_PROPOSAL,
        ids.allowProposal,
      ],
      [
        "sample-audit-approval",
        AuditEventType.POLICY_APPROVAL_REQUIRED,
        AuditEntityType.PURCHASE_PROPOSAL,
        ids.approvalProposal,
      ],
      [
        "sample-audit-block",
        AuditEventType.POLICY_BLOCKED,
        AuditEntityType.PURCHASE_PROPOSAL,
        ids.blockedProposal,
      ],
      [
        "sample-audit-capture",
        AuditEventType.PAYMENT_CAPTURED,
        AuditEntityType.PAYMENT,
        ids.payment,
      ],
    ] as const;
    for (const [dedupeKey, eventType, entityType, entityId] of auditEvents) {
      if (!(await tx.auditEvent.findUnique({ where: { dedupeKey } }))) {
        await tx.auditEvent.create({
          data: {
            userId: ids.user,
            eventType,
            entityType,
            entityId,
            dedupeKey,
            isSample: true,
            payload: json({ sample: true, source: "seed" }),
          },
        });
      }
    }
  });
}

try {
  await main();
} finally {
  await db.$disconnect();
}
