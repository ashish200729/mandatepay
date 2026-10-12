import { randomUUID } from "node:crypto";
import {
  AuditEntityType,
  AuditEventType,
  PaymentProfileStatus,
  type DatabaseClient,
  type Prisma,
} from "@mandatepay/database";
import {
  PAYPAL_ENVIRONMENTS,
  PayPalError,
  PayPalProviderError,
  isDefinitivePayPalRejection,
  type AuthoritativeWebhookData,
  type CreateVaultPaymentTokenInput,
  type CreateVaultSetupTokenInput,
  type PayPalEnvironmentHosts,
  type PayPalVaultDeletion,
  type PayPalVaultPaymentToken,
  type PayPalVaultSetupToken,
  type PayPalWebhookEvent,
} from "@mandatepay/paypal";
import { assertNewCheckout } from "./platform-controls.js";
import { VaultCipherError, maskEmail, type VaultCipher } from "./vault-crypto.js";

type Owner = { id: string };
type TransactionClient = Prisma.TransactionClient;

/** Bumped whenever the consent wording in Settings changes materially. */
export const VAULT_CONSENT_VERSION = "2026-10-12";

/** PayPal setup tokens expire after about three days; stop offering a link well before. */
const SETUP_TOKEN_LIFETIME_MS = 3 * 24 * 60 * 60_000 - 60 * 60_000;
/** An unconfirmed setup request is replayed with its PayPal-Request-Id only while fresh. */
const SETUP_REQUEST_REPLAY_MS = 24 * 60 * 60_000;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/u;

export interface VaultGateway {
  createVaultSetupToken?(input: CreateVaultSetupTokenInput): Promise<PayPalVaultSetupToken>;
  createVaultPaymentToken?(input: CreateVaultPaymentTokenInput): Promise<PayPalVaultPaymentToken>;
  deleteVaultPaymentToken?(paymentTokenId: string): Promise<PayPalVaultDeletion>;
  readonly hosts?: PayPalEnvironmentHosts;
}

export interface PaymentMethodContext {
  readonly database: DatabaseClient;
  readonly paypal: VaultGateway | null;
  readonly appUrl: string;
  /** Null when TOKEN_ENCRYPTION_KEY is missing or not exactly 32 bytes: vaulting stays off. */
  readonly vault: VaultCipher | null;
}

export type PaymentMethodErrorCode =
  | "VAULT_UNAVAILABLE"
  | "SETUP_NOT_FOUND"
  | "SETUP_EXPIRED"
  | "SETUP_NOT_APPROVED"
  | "REMOVAL_PENDING"
  | "PAYPAL_OUTCOME_UNKNOWN"
  | "PAYPAL_RESPONSE_INVALID"
  | "PAYPAL_REQUEST_REJECTED";

export class PaymentMethodError extends Error {
  constructor(
    readonly code: PaymentMethodErrorCode,
    readonly httpStatus: number,
  ) {
    super("The saved PayPal payment method could not be updated.");
    this.name = "PaymentMethodError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type PaymentMethodStatus =
  "NONE" | "SETUP_PENDING" | "ACTIVE" | "REMOVAL_PENDING" | "REVOKED";

export interface PaymentMethodDTO {
  readonly provider: "paypal";
  readonly status: PaymentMethodStatus;
  /** Whether this server can save PayPal (Vault-capable client and a valid encryption key). */
  readonly available: boolean;
  /** Masked, display-only payer email. The payment token id is never returned. */
  readonly payerEmail: string | null;
  readonly activatedAt: string | null;
  readonly removalRequestedAt: string | null;
  readonly revokedAt: string | null;
  readonly consentVersion: string | null;
  readonly currentConsentVersion: string;
}

type ProfileRecord = Prisma.PaymentProfileGetPayload<object>;

export function vaultAvailable(context: PaymentMethodContext) {
  return Boolean(
    context.vault &&
    context.paypal?.createVaultSetupToken &&
    context.paypal.createVaultPaymentToken &&
    context.paypal.deleteVaultPaymentToken,
  );
}

function status(profile: ProfileRecord | null): PaymentMethodStatus {
  switch (profile?.status) {
    case PaymentProfileStatus.SETUP_PENDING:
      return "SETUP_PENDING";
    case PaymentProfileStatus.ACTIVE:
      return "ACTIVE";
    case PaymentProfileStatus.REMOVAL_PENDING:
      return "REMOVAL_PENDING";
    case PaymentProfileStatus.REVOKED:
      return "REVOKED";
    default:
      return "NONE";
  }
}

export function paymentMethodDTO(
  context: PaymentMethodContext,
  profile: ProfileRecord | null,
): PaymentMethodDTO {
  const current = status(profile);
  return {
    provider: "paypal",
    status: current,
    available: vaultAvailable(context),
    payerEmail:
      current === "ACTIVE" || current === "REMOVAL_PENDING"
        ? (profile?.payerEmailMasked ?? null)
        : null,
    activatedAt: profile?.activatedAt?.toISOString() ?? null,
    removalRequestedAt: profile?.removalRequestedAt?.toISOString() ?? null,
    revokedAt: profile?.revokedAt?.toISOString() ?? null,
    consentVersion: profile?.consentVersion ?? null,
    currentConsentVersion: VAULT_CONSENT_VERSION,
  };
}

function safeCode(value: string | null | undefined) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function issueOf(error: PayPalProviderError) {
  return safeCode(error.issue) ?? safeCode(error.providerName);
}

function settingsRedirect(appUrl: string, result: "return" | "cancel") {
  try {
    return new URL(`/settings?vault=${result}`, appUrl).toString();
  } catch {
    throw new PaymentMethodError("VAULT_UNAVAILABLE", 503);
  }
}

function safeApprovalUrl(context: PaymentMethodContext, value: string | null) {
  const hosts = context.paypal?.hosts ?? PAYPAL_ENVIRONMENTS.sandbox;
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts.approvalHosts.includes(url.hostname)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function lockUser(tx: TransactionClient, userId: string) {
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
  return tx.paymentProfile.findUnique({ where: { userId } });
}

function providerFailure(error: unknown): PaymentMethodError {
  if (error instanceof PaymentMethodError) return error;
  if (isDefinitivePayPalRejection(error)) {
    return new PaymentMethodError("PAYPAL_REQUEST_REJECTED", 422);
  }
  if (error instanceof PayPalError && !(error instanceof PayPalProviderError)) {
    return new PaymentMethodError("PAYPAL_RESPONSE_INVALID", 503);
  }
  return new PaymentMethodError("PAYPAL_OUTCOME_UNKNOWN", 503);
}

const clearedSetup = {
  setupTokenId: null,
  setupRequestId: null,
  setupApprovalUrl: null,
  setupExpiresAt: null,
  paymentTokenRequestId: null,
} as const;

export async function getPaymentMethod(context: PaymentMethodContext, user: Owner) {
  let profile = await context.database.paymentProfile.findUnique({ where: { userId: user.id } });
  // A removal PayPal has not confirmed is retried whenever its owner looks at it.
  if (profile?.status === PaymentProfileStatus.REMOVAL_PENDING && vaultAvailable(context)) {
    profile = await finishVaultRemoval(context, user);
  }
  return paymentMethodDTO(context, profile);
}

/**
 * Records explicit consent and asks PayPal for a setup token. Returns the
 * validated PayPal approval link for the browser to open.
 */
export async function startVaultSetup(context: PaymentMethodContext, user: Owner) {
  if (!vaultAvailable(context) || !context.paypal?.createVaultSetupToken) {
    throw new PaymentMethodError("VAULT_UNAVAILABLE", 503);
  }
  await assertNewCheckout(context.database);
  const claimed = await context.database.$transaction(async (tx) => {
    const profile = await lockUser(tx, user.id);
    const now = Date.now();
    if (profile?.status === PaymentProfileStatus.ACTIVE) {
      return { kind: "done", profile } as const;
    }
    if (profile?.status === PaymentProfileStatus.REMOVAL_PENDING) {
      throw new PaymentMethodError("REMOVAL_PENDING", 409);
    }
    if (profile?.status === PaymentProfileStatus.SETUP_PENDING && profile.setupRequestId) {
      const reusableLink =
        profile.setupTokenId &&
        profile.setupApprovalUrl &&
        profile.setupExpiresAt &&
        profile.setupExpiresAt.getTime() > now + 10 * 60_000;
      if (reusableLink) return { kind: "link", profile } as const;
      const replayable =
        !profile.setupTokenId &&
        profile.consentedAt &&
        profile.consentedAt.getTime() > now - SETUP_REQUEST_REPLAY_MS;
      if (replayable) return { kind: "request", profile } as const;
    }
    const data = {
      status: PaymentProfileStatus.SETUP_PENDING,
      ...clearedSetup,
      setupRequestId: randomUUID(),
      consentVersion: VAULT_CONSENT_VERSION,
      consentedAt: new Date(now),
      lastErrorCode: null,
    };
    const saved = profile
      ? await tx.paymentProfile.update({ where: { id: profile.id }, data })
      : await tx.paymentProfile.create({ data: { userId: user.id, ...data } });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_METHOD_SETUP_STARTED,
        entityType: AuditEntityType.PAYMENT_PROFILE,
        entityId: saved.id,
        payload: { provider: "paypal", consentVersion: VAULT_CONSENT_VERSION },
      },
    });
    return { kind: "request", profile: saved } as const;
  });

  if (claimed.kind === "done") {
    return { paymentMethod: paymentMethodDTO(context, claimed.profile), approvalUrl: null };
  }
  if (claimed.kind === "link") {
    const approvalUrl = safeApprovalUrl(context, claimed.profile.setupApprovalUrl);
    if (!approvalUrl) throw new PaymentMethodError("PAYPAL_RESPONSE_INVALID", 503);
    return { paymentMethod: paymentMethodDTO(context, claimed.profile), approvalUrl };
  }

  const requestId = claimed.profile.setupRequestId;
  if (!requestId) throw new PaymentMethodError("VAULT_UNAVAILABLE", 503);
  let token: PayPalVaultSetupToken;
  try {
    token = await context.paypal.createVaultSetupToken({
      requestId,
      returnUrl: settingsRedirect(context.appUrl, "return"),
      cancelUrl: settingsRedirect(context.appUrl, "cancel"),
    });
  } catch (error) {
    if (isDefinitivePayPalRejection(error)) {
      await context.database.$transaction(async (tx) => {
        const current = await lockUser(tx, user.id);
        if (current?.setupRequestId !== requestId) return;
        await tx.paymentProfile.update({
          where: { id: current.id },
          data: {
            status: PaymentProfileStatus.DISCONNECTED,
            ...clearedSetup,
            lastErrorCode: `PAYPAL_SETUP_REJECTED${issueOf(error) ? `:${issueOf(error)}` : ""}`,
          },
        });
      });
    }
    throw providerFailure(error);
  }
  const approvalUrl = safeApprovalUrl(context, token.approvalUrl);
  if (!approvalUrl) throw new PaymentMethodError("PAYPAL_RESPONSE_INVALID", 503);
  const saved = await context.database.$transaction(async (tx) => {
    const current = await lockUser(tx, user.id);
    if (
      !current ||
      current.status !== PaymentProfileStatus.SETUP_PENDING ||
      current.setupRequestId !== requestId
    ) {
      return null;
    }
    return tx.paymentProfile.update({
      where: { id: current.id },
      data: {
        setupTokenId: token.id,
        setupApprovalUrl: approvalUrl,
        setupExpiresAt: new Date(Date.now() + SETUP_TOKEN_LIFETIME_MS),
      },
    });
  });
  if (!saved) throw new PaymentMethodError("SETUP_NOT_FOUND", 409);
  return { paymentMethod: paymentMethodDTO(context, saved), approvalUrl };
}

/**
 * Called after PayPal returns the buyer to Settings. Query parameters from the
 * redirect are ignored; the stored setup token is exchanged for a payment token.
 */
export async function completeVaultSetup(context: PaymentMethodContext, user: Owner) {
  if (!vaultAvailable(context) || !context.paypal?.createVaultPaymentToken || !context.vault) {
    throw new PaymentMethodError("VAULT_UNAVAILABLE", 503);
  }
  const cipher = context.vault;
  const claimed = await context.database.$transaction(async (tx) => {
    const profile = await lockUser(tx, user.id);
    if (profile?.status === PaymentProfileStatus.ACTIVE) {
      return { kind: "done", profile } as const;
    }
    if (profile?.status !== PaymentProfileStatus.SETUP_PENDING || !profile.setupTokenId) {
      throw new PaymentMethodError("SETUP_NOT_FOUND", 409);
    }
    if (!profile.setupExpiresAt || profile.setupExpiresAt.getTime() <= Date.now()) {
      await tx.paymentProfile.update({
        where: { id: profile.id },
        data: {
          status: PaymentProfileStatus.DISCONNECTED,
          ...clearedSetup,
          lastErrorCode: "SETUP_EXPIRED",
        },
      });
      return { kind: "expired" } as const;
    }
    const pending = profile.paymentTokenRequestId
      ? profile
      : await tx.paymentProfile.update({
          where: { id: profile.id },
          data: { paymentTokenRequestId: randomUUID() },
        });
    return { kind: "pending", profile: pending } as const;
  });
  if (claimed.kind === "done") return { paymentMethod: paymentMethodDTO(context, claimed.profile) };
  if (claimed.kind === "expired") throw new PaymentMethodError("SETUP_EXPIRED", 409);

  const setupTokenId = claimed.profile.setupTokenId;
  const requestId = claimed.profile.paymentTokenRequestId;
  if (!setupTokenId || !requestId) throw new PaymentMethodError("SETUP_NOT_FOUND", 409);
  let token: PayPalVaultPaymentToken;
  try {
    token = await context.paypal.createVaultPaymentToken({ setupTokenId, requestId });
  } catch (error) {
    if (isDefinitivePayPalRejection(error)) {
      await context.database.$transaction(async (tx) => {
        const current = await lockUser(tx, user.id);
        if (
          current?.status !== PaymentProfileStatus.SETUP_PENDING ||
          current.setupTokenId !== setupTokenId
        )
          return;
        await tx.paymentProfile.update({
          where: { id: current.id },
          data: {
            status: PaymentProfileStatus.DISCONNECTED,
            ...clearedSetup,
            lastErrorCode: `PAYPAL_SETUP_NOT_APPROVED${issueOf(error) ? `:${issueOf(error)}` : ""}`,
          },
        });
      });
      throw new PaymentMethodError("SETUP_NOT_APPROVED", 409);
    }
    throw providerFailure(error);
  }

  const outcome = await context.database.$transaction(async (tx) => {
    const current = await lockUser(tx, user.id);
    if (
      !current ||
      current.status !== PaymentProfileStatus.SETUP_PENDING ||
      current.setupTokenId !== setupTokenId
    ) {
      // The user cancelled or removed the method while PayPal was answering.
      return { kind: "orphaned", profile: current } as const;
    }
    const customerTaken = token.customerId
      ? await tx.paymentProfile.findFirst({
          where: { paypalCustomerId: token.customerId, NOT: { userId: user.id } },
          select: { id: true },
        })
      : null;
    const now = new Date();
    const saved = await tx.paymentProfile.update({
      where: { id: current.id },
      data: {
        status: PaymentProfileStatus.ACTIVE,
        paypalVaultIdEncrypted: cipher.encrypt(user.id, token.id),
        paypalVaultIdHash: cipher.hash(token.id),
        paypalCustomerId: customerTaken ? null : token.customerId,
        payerEmailMasked: maskEmail(token.payerEmail),
        activatedAt: now,
        removalRequestedAt: null,
        revokedAt: null,
        lastErrorCode: null,
        ...clearedSetup,
      },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_METHOD_SAVED,
        entityType: AuditEntityType.PAYMENT_PROFILE,
        entityId: saved.id,
        payload: {
          provider: "paypal",
          consentVersion: saved.consentVersion,
          payerEmail: saved.payerEmailMasked,
        },
      },
    });
    return { kind: "saved", profile: saved } as const;
  });
  if (outcome.kind === "orphaned") {
    // Never keep a token the user no longer wants; deletion is idempotent.
    await context.paypal.deleteVaultPaymentToken?.(token.id).catch(() => undefined);
  }
  return { paymentMethod: paymentMethodDTO(context, outcome.profile) };
}

export async function cancelVaultSetup(context: PaymentMethodContext, user: Owner) {
  const profile = await context.database.$transaction(async (tx) => {
    const current = await lockUser(tx, user.id);
    if (current?.status !== PaymentProfileStatus.SETUP_PENDING) return current;
    return tx.paymentProfile.update({
      where: { id: current.id },
      data: { status: PaymentProfileStatus.DISCONNECTED, ...clearedSetup },
    });
  });
  return { paymentMethod: paymentMethodDTO(context, profile) };
}

/**
 * Stops autonomous use immediately (REMOVAL_PENDING is never charged), then
 * deletes the token at PayPal. Only PayPal's confirmation (or 404) marks it
 * REVOKED; an unreachable PayPal leaves it pending for a later retry.
 */
export async function removeVaultMethod(context: PaymentMethodContext, user: Owner) {
  const profile = await context.database.$transaction(async (tx) => {
    const current = await lockUser(tx, user.id);
    if (!current) return null;
    if (current.status === PaymentProfileStatus.SETUP_PENDING) {
      return tx.paymentProfile.update({
        where: { id: current.id },
        data: { status: PaymentProfileStatus.DISCONNECTED, ...clearedSetup },
      });
    }
    if (current.status !== PaymentProfileStatus.ACTIVE) return current;
    const updated = await tx.paymentProfile.update({
      where: { id: current.id },
      data: { status: PaymentProfileStatus.REMOVAL_PENDING, removalRequestedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_METHOD_REMOVAL_REQUESTED,
        entityType: AuditEntityType.PAYMENT_PROFILE,
        entityId: current.id,
        payload: { provider: "paypal" },
      },
    });
    return updated;
  });
  if (profile?.status !== PaymentProfileStatus.REMOVAL_PENDING) {
    return { paymentMethod: paymentMethodDTO(context, profile) };
  }
  return { paymentMethod: paymentMethodDTO(context, await finishVaultRemoval(context, user)) };
}

async function markRemovalError(context: PaymentMethodContext, profileId: string, code: string) {
  return context.database.paymentProfile.update({
    where: { id: profileId },
    data: { lastErrorCode: code },
  });
}

/** Retries PayPal deletion for a profile in REMOVAL_PENDING. Safe to call repeatedly. */
export async function finishVaultRemoval(context: PaymentMethodContext, user: Owner) {
  const profile = await context.database.paymentProfile.findUnique({ where: { userId: user.id } });
  if (profile?.status !== PaymentProfileStatus.REMOVAL_PENDING) return profile;
  if (!context.vault || !context.paypal?.deleteVaultPaymentToken) {
    return markRemovalError(context, profile.id, "VAULT_UNAVAILABLE");
  }
  if (!profile.paypalVaultIdEncrypted) {
    return markRemovalError(context, profile.id, "VAULT_TOKEN_MISSING");
  }
  let tokenId: string;
  try {
    tokenId = context.vault.decrypt(user.id, profile.paypalVaultIdEncrypted);
  } catch (error) {
    if (!(error instanceof VaultCipherError)) throw error;
    return markRemovalError(context, profile.id, "VAULT_TOKEN_UNREADABLE");
  }
  let deletion: PayPalVaultDeletion;
  try {
    deletion = await context.paypal.deleteVaultPaymentToken(tokenId);
  } catch {
    return markRemovalError(context, profile.id, "PAYPAL_DELETE_UNCONFIRMED");
  }
  return context.database.$transaction(async (tx) => {
    const current = await lockUser(tx, user.id);
    if (current?.status !== PaymentProfileStatus.REMOVAL_PENDING) return current;
    const revoked = await tx.paymentProfile.update({
      where: { id: current.id },
      data: {
        status: PaymentProfileStatus.REVOKED,
        revokedAt: new Date(),
        paypalVaultIdEncrypted: null,
        lastErrorCode: null,
      },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        eventType: AuditEventType.PAYMENT_METHOD_REVOKED,
        entityType: AuditEntityType.PAYMENT_PROFILE,
        entityId: current.id,
        payload: {
          provider: "paypal",
          source: "user",
          alreadyAbsentAtPayPal: deletion.alreadyAbsent,
        },
      },
    });
    return revoked;
  });
}

/**
 * Reconciles a verified VAULT.PAYMENT-TOKEN.* event re-read from PayPal.
 * DELETED (for example revoked by the buyer in PayPal) revokes the local
 * profile once PayPal confirms the token is gone. CREATED is idempotent and
 * never activates or re-activates a method on its own.
 */
export async function reconcileVaultTokenEvent(
  database: DatabaseClient,
  vault: VaultCipher | null,
  event: PayPalWebhookEvent,
  authoritative: Extract<AuthoritativeWebhookData, { kind: "payment_token" }>,
): Promise<"processed" | "pending" | "ignored"> {
  if (!vault) return "ignored";
  const hash = vault.hash(authoritative.tokenId);
  const candidate = await database.paymentProfile.findUnique({
    where: { paypalVaultIdHash: hash },
    select: { userId: true },
  });
  if (!candidate) return "ignored";
  if (authoritative.eventType === "VAULT.PAYMENT-TOKEN.CREATED") {
    return authoritative.token ? "processed" : "ignored";
  }
  // PayPal still reports the token: deletion has not propagated yet.
  if (authoritative.token) return "pending";
  return database.$transaction(async (tx) => {
    const current = await lockUser(tx, candidate.userId);
    if (!current || current.paypalVaultIdHash !== hash) return "ignored";
    if (
      current.status !== PaymentProfileStatus.ACTIVE &&
      current.status !== PaymentProfileStatus.REMOVAL_PENDING
    ) {
      return "processed";
    }
    await tx.paymentProfile.update({
      where: { id: current.id },
      data: {
        status: PaymentProfileStatus.REVOKED,
        revokedAt: new Date(),
        paypalVaultIdEncrypted: null,
        lastErrorCode: null,
      },
    });
    await tx.auditEvent.create({
      data: {
        userId: current.userId,
        eventType: AuditEventType.PAYMENT_METHOD_REVOKED,
        entityType: AuditEntityType.PAYMENT_PROFILE,
        entityId: current.id,
        dedupeKey: `payment-method-revoked:webhook:${event.id}`.slice(0, 255),
        payload: { provider: "paypal", source: "paypal_webhook", webhookEventId: event.id },
      },
    });
    return "processed";
  });
}
