import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { evaluatePurchase, type DecisionExplanation } from "@mandatepay/agentguard";
import { DatabaseError, assertCurrency, type DatabaseClient } from "@mandatepay/database";
import {
  CanonicalMandateSchema,
  DomainError,
  calculatePurchaseTotal,
  multiplyMinorUnits,
  toMinorUnits,
} from "@mandatepay/shared";
import { explainStoredDecision } from "../services/decision-explanation.js";
import { platformAutonomyEnabled } from "../services/platform-controls.js";
import { readSimulationSpendContext, type TransactionClient } from "../services/proposals.js";
import { createFixedWindowRateLimiter } from "../services/rate-limits.js";

type AuthenticatedUser = { id: string };

export interface SimulatorRouteContext {
  database: DatabaseClient;
  requireUser: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthenticatedUser | null | undefined>;
  isTrustedOrigin: (origin: string | undefined) => boolean;
  /** Per-user simulations per minute. */
  rateLimitPerMinute?: number;
  now?: () => Date;
}

/** $1,000,000 per unit, shipping or tax: far above any mandate, far below unsafe integers. */
export const SIMULATOR_MAX_MINOR = 100_000_000;
export const SIMULATOR_MAX_QUANTITY = 100;
export const SIMULATOR_RATE_LIMIT_PER_MINUTE = 60;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
const minorSchema = z.number().int().min(0).max(SIMULATOR_MAX_MINOR);

export const SimulationRequestSchema = z
  .object({
    price: z.number().int().min(1).max(SIMULATOR_MAX_MINOR),
    quantity: z.number().int().min(1).max(SIMULATOR_MAX_QUANTITY).default(1),
    condition: z.enum(["NEW", "USED", "REFURBISHED"]),
    brand: optionalText(120),
    category: optionalText(120),
    merchant: z.string().trim().min(1).max(200),
    shipping: minorSchema.default(0),
    tax: minorSchema.default(0),
    /** Overrides purchase-history detection to show how a new store is treated. */
    asNewMerchant: z.boolean().optional(),
  })
  .strict();
export type SimulationRequest = z.output<typeof SimulationRequestSchema>;

export interface SimulationResult {
  readonly simulated: true;
  readonly decision: "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";
  readonly reasonCodes: readonly string[];
  readonly explanation: DecisionExplanation | null;
  readonly mandate: { readonly id: string; readonly version: number; readonly status: string };
  readonly facts: {
    readonly subtotal: number;
    readonly total: number;
    readonly currency: "USD";
    readonly isNewMerchant: boolean;
    readonly newMerchantSource: "history" | "override";
  };
}

const idSchema = z.object({ id: z.string().trim().min(1).max(255) });

function originOf(request: FastifyRequest) {
  const value = request.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function jsonError(reply: FastifyReply, statusCode: number, code: string, error: string) {
  return reply.status(statusCode).send({ error, code });
}

const SIMULATION_ID = "agentguard-simulation";

/**
 * Evaluates a hypothetical purchase against the mandate's current active
 * version with the real AgentGuard engine and the same inputs a proposal
 * evaluation builds: confirmed spend, live holds, the user's autonomy and the
 * platform autonomy switch. It runs in a READ ONLY database transaction, so it
 * can never create a proposal, reservation, approval, decision or audit row.
 */
export async function simulateMandatePurchase(
  database: DatabaseClient,
  user: AuthenticatedUser,
  mandateId: string,
  input: SimulationRequest,
  clock: () => Date = () => new Date(),
): Promise<SimulationResult> {
  let subtotal: number;
  let total: number;
  try {
    subtotal = multiplyMinorUnits(toMinorUnits(input.price), input.quantity);
    total = calculatePurchaseTotal({
      subtotal: toMinorUnits(subtotal),
      shipping: toMinorUnits(input.shipping),
      tax: toMinorUnits(input.tax),
    });
  } catch (cause) {
    if (cause instanceof DomainError) {
      throw new DatabaseError("INVALID_MONEY", "Simulated totals are not representable.");
    }
    throw cause;
  }
  return database.$transaction(async (tx: TransactionClient) => {
    // Database-enforced guarantee: any write in this transaction fails.
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const mandate = await tx.mandate.findFirst({
      where: { id: mandateId, userId: user.id },
      include: { activeVersion: true },
    });
    if (!mandate) throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
    const version = mandate.activeVersion;
    if (!version) throw new DatabaseError("INVALID_STATE", "Mandate has no active version.");
    assertCurrency(version.currency);
    const parsedRules = CanonicalMandateSchema.safeParse(version.canonicalRules);
    if (!parsedRules.success) {
      throw new DatabaseError("INVALID_STATE", "Mandate canonical snapshot is invalid.");
    }
    // A real evaluation also refuses outside the stored validity window; show
    // that as AgentGuard's own not-started/expired verdict.
    const rules = {
      ...parsedRules.data,
      startsAt: parsedRules.data.startsAt ?? mandate.startsAt.toISOString(),
      expiresAt: parsedRules.data.expiresAt ?? mandate.expiresAt.toISOString(),
    };
    const account = await tx.user.findUnique({
      where: { id: user.id },
      select: { globalAutonomousPurchasingEnabled: true, disabledAt: true },
    });
    if (!account) throw new DatabaseError("NOT_FOUND", "User was not found.");
    if (account.disabledAt) throw new DatabaseError("INVALID_STATE", "Account is disabled.");

    const now = clock();
    const { isNewMerchant: detectedNewMerchant, ...spend } = await readSimulationSpendContext(tx, {
      mandateId: mandate.id,
      userId: user.id,
      merchant: input.merchant,
      now,
    });
    const isNewMerchant = input.asNewMerchant ?? detectedNewMerchant;
    const platformAutonomy = await platformAutonomyEnabled(tx);
    const decision = evaluatePurchase({
      now: now.toISOString(),
      mandate: {
        id: mandate.id,
        version: version.version,
        status: mandate.status,
        rules,
      },
      proposal: {
        mandateId: mandate.id,
        mandateVersion: version.version,
        productSnapshotId: SIMULATION_ID,
        quantity: input.quantity,
        subtotal,
        shipping: input.shipping,
        tax: input.tax,
        total,
        currency: "USD",
        idempotencyKey: SIMULATION_ID,
      },
      product: {
        snapshotId: SIMULATION_ID,
        brand: input.brand,
        category: input.category,
        condition: input.condition,
        merchantId: input.merchant,
        merchant: input.merchant,
        isNewMerchant,
        unitPrice: input.price,
        currency: "USD",
        quantity: input.quantity,
      },
      spend,
      globalAutonomousPurchasingEnabled:
        account.globalAutonomousPurchasingEnabled && platformAutonomy,
    });
    // Explained exactly as a persisted decision would be, from the same snapshots.
    const explanation = explainStoredDecision(
      {
        decision: decision.decision,
        reasonCodes: decision.reasonCodes,
        rulesSnapshot: rules,
        spendSnapshot: {
          ...spend,
          isNewMerchant,
          globalAutonomousPurchasingEnabled: account.globalAutonomousPurchasingEnabled,
        },
      },
      {
        total,
        currency: "USD",
        quantity: input.quantity,
        productSnapshot: {
          brand: input.brand ?? null,
          category: input.category ?? null,
          condition: input.condition,
          merchant: input.merchant,
        },
        mandateVersion: { version: version.version },
      },
    );
    return {
      simulated: true as const,
      decision: decision.decision,
      reasonCodes: [...decision.reasonCodes],
      explanation,
      mandate: { id: mandate.id, version: version.version, status: mandate.status },
      facts: {
        subtotal,
        total,
        currency: "USD" as const,
        isNewMerchant,
        newMerchantSource:
          input.asNewMerchant === undefined ? ("history" as const) : ("override" as const),
      },
    };
  });
}

function handleError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof DatabaseError) {
    if (cause.code === "NOT_FOUND") {
      return jsonError(reply, 404, "NOT_FOUND", "Mandate not found.");
    }
    if (cause.code === "INVALID_MONEY" || cause.code === "INVALID_DOMAIN_INPUT") {
      return jsonError(reply, 400, "INVALID_REQUEST", "Simulation request is invalid.");
    }
    if (cause.code === "INVALID_STATE" || cause.code === "INVALID_CURRENCY") {
      return jsonError(
        reply,
        409,
        "INVALID_STATE",
        "This mandate can’t be simulated in its current state.",
      );
    }
  }
  return jsonError(
    reply,
    503,
    "SIMULATOR_UNAVAILABLE",
    "The policy simulator is temporarily unavailable.",
  );
}

export function registerSimulatorRoutes(app: FastifyInstance, context: SimulatorRouteContext) {
  const consume = createFixedWindowRateLimiter({
    maximum: context.rateLimitPerMinute ?? SIMULATOR_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    capacity: 2_048,
  });

  app.post("/api/mandates/:id/simulate", async (request, reply) => {
    if (!context.isTrustedOrigin(originOf(request))) {
      return jsonError(reply, 403, "ORIGIN_NOT_TRUSTED", "Request origin is not trusted.");
    }
    const user = await context.requireUser(request, reply);
    if (!user) return;
    const rate = consume(user.id);
    if (!rate.allowed) {
      reply.header("retry-after", String(rate.retryAfter));
      return jsonError(
        reply,
        429,
        "RATE_LIMITED",
        "Too many simulations. Wait a moment and try again.",
      );
    }
    const id = idSchema.safeParse(request.params);
    const body = SimulationRequestSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      return jsonError(reply, 400, "INVALID_REQUEST", "Simulation request is invalid.");
    }
    try {
      return reply.send(
        await simulateMandatePurchase(context.database, user, id.data.id, body.data, context.now),
      );
    } catch (cause) {
      return handleError(reply, cause);
    }
  });
}
