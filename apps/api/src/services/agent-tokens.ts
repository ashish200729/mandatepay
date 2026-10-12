import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentTokenScope,
  AuditEntityType,
  AuditEventType,
  type DatabaseClient,
} from "@mandatepay/database";

/** Every agent access token starts with this prefix, so leaked tokens are easy to recognise. */
export const AGENT_TOKEN_PREFIX = "mp_agent_";
/** 32 random bytes, base64url without padding. */
const TOKEN_PATTERN = /^mp_agent_[A-Za-z0-9_-]{43}$/u;
const DISPLAY_PREFIX_LENGTH = AGENT_TOKEN_PREFIX.length + 6;
export const AGENT_TOKEN_MAX_ACTIVE = 10;
export const AGENT_TOKEN_EXPIRY_DAYS = [7, 30, 90] as const;
/** lastUsedAt is written at most once per window, so a busy agent does not write every request. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export type AgentTokenScopeName = keyof typeof AgentTokenScope;
const SCOPE_ORDER: readonly AgentTokenScopeName[] = ["READ", "PROPOSE", "AUTOPAY"];

export const CreateAgentTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      // Plain labels only: no control, bidi or markup characters in a name shown in audits.
      .regex(/^[\p{L}\p{N} ._()'’-]+$/u),
    scopes: z
      .array(z.enum(["READ", "PROPOSE", "AUTOPAY"]))
      .min(1)
      .max(3)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique.")
      .refine((scopes) => scopes.includes("READ"), "READ is required.")
      .refine(
        (scopes) => !scopes.includes("AUTOPAY") || scopes.includes("PROPOSE"),
        "AUTOPAY requires PROPOSE.",
      ),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  })
  .strict();
export type CreateAgentTokenInput = z.output<typeof CreateAgentTokenSchema>;

export type AgentTokenErrorCode = "TOKEN_LIMIT_REACHED" | "TOKEN_NOT_FOUND";

export class AgentTokenError extends Error {
  constructor(
    readonly code: AgentTokenErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentTokenError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Separates the agent-token HMAC key from Better Auth's session secret. */
export function deriveAgentTokenKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "mandatepay", "mandatepay/agent-token/v1", 32));
}

export function generateAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isAgentTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashAgentToken(key: Buffer, token: string): string {
  return createHmac("sha256", key).update(token, "utf8").digest("hex");
}

export type AgentTokenStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface AgentTokenDTO {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: AgentTokenScopeName[];
  readonly status: AgentTokenStatus;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

type TokenRecord = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: AgentTokenScope[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const tokenSelect = {
  id: true,
  name: true,
  tokenPrefix: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

function orderedScopes(scopes: readonly string[]): AgentTokenScopeName[] {
  return SCOPE_ORDER.filter((scope) => scopes.includes(scope));
}

export function agentTokenDTO(record: TokenRecord, now = new Date()): AgentTokenDTO {
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    scopes: orderedScopes(record.scopes),
    status: record.revokedAt ? "REVOKED" : record.expiresAt <= now ? "EXPIRED" : "ACTIVE",
    expiresAt: record.expiresAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function listAgentTokens(database: DatabaseClient, userId: string) {
  const tokens = await database.agentAccessToken.findMany({
    where: { userId },
    select: tokenSelect,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const now = new Date();
  return tokens.map((token) => agentTokenDTO(token, now));
}

/**
 * Creates a token and returns its plaintext exactly once. Only the keyed HMAC
 * is stored. The user row lock serialises the active-token limit.
 */
export async function createAgentToken(
  database: DatabaseClient,
  key: Buffer,
  userId: string,
  input: CreateAgentTokenInput,
): Promise<{ token: string; agentToken: AgentTokenDTO }> {
  const token = generateAgentToken();
  const tokenHash = hashAgentToken(key, token);
  const created = await database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
    const now = new Date();
    const active = await tx.agentAccessToken.count({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
    });
    if (active >= AGENT_TOKEN_MAX_ACTIVE) {
      throw new AgentTokenError(
        "TOKEN_LIMIT_REACHED",
        409,
        `You can have up to ${AGENT_TOKEN_MAX_ACTIVE} active agent connections. Revoke one first.`,
      );
    }
    const scopes = orderedScopes(input.scopes);
    const record = await tx.agentAccessToken.create({
      data: {
        userId,
        name: input.name,
        tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
        tokenHash,
        scopes,
        createdAt: now,
        expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
      },
      select: tokenSelect,
    });
    await tx.auditEvent.create({
      data: {
        userId,
        eventType: AuditEventType.AGENT_TOKEN_CREATED,
        entityType: AuditEntityType.USER,
        entityId: userId,
        payload: {
          agentTokenId: record.id,
          name: record.name,
          tokenPrefix: record.tokenPrefix,
          scopes,
          expiresAt: record.expiresAt.toISOString(),
        },
      },
    });
    return record;
  });
  return { token, agentToken: agentTokenDTO(created) };
}

/** Revokes an owned token. Repeating it is a no-op that records no second audit event. */
export async function revokeAgentToken(database: DatabaseClient, userId: string, id: string) {
  return database.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
    const existing = await tx.agentAccessToken.findFirst({
      where: { id, userId },
      select: tokenSelect,
    });
    if (!existing) {
      throw new AgentTokenError("TOKEN_NOT_FOUND", 404, "Agent connection not found.");
    }
    if (existing.revokedAt) return agentTokenDTO(existing);
    const revoked = await tx.agentAccessToken.update({
      where: { id },
      data: { revokedAt: new Date() },
      select: tokenSelect,
    });
    await tx.auditEvent.create({
      data: {
        userId,
        eventType: AuditEventType.AGENT_TOKEN_REVOKED,
        entityType: AuditEntityType.USER,
        entityId: userId,
        payload: { agentTokenId: revoked.id, name: revoked.name, tokenPrefix: revoked.tokenPrefix },
      },
    });
    return agentTokenDTO(revoked);
  });
}

export interface AgentPrincipal {
  readonly user: { readonly id: string };
  readonly token: {
    readonly id: string;
    readonly name: string;
    readonly scopes: readonly AgentTokenScopeName[];
  };
}

export type AgentAuthFailure =
  "MISSING" | "MALFORMED" | "UNKNOWN" | "EXPIRED" | "REVOKED" | "ACCOUNT_DISABLED";

/** Reads `Authorization: Bearer mp_agent_…`. Cookies are never consulted. */
export function bearerAgentToken(header: string | string[] | undefined): string | null | "" {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer[ ]+(\S+)$/iu.exec(value.trim());
  return match?.[1] && isAgentTokenFormat(match[1]) ? match[1] : "";
}

/**
 * Resolves a bearer token to its owner. The lookup is by keyed HMAC, and the
 * stored digest is compared again in constant time before it is trusted.
 */
export async function authenticateAgentToken(
  database: DatabaseClient,
  key: Buffer,
  authorization: string | string[] | undefined,
  now = new Date(),
): Promise<{ ok: true; principal: AgentPrincipal } | { ok: false; reason: AgentAuthFailure }> {
  const token = bearerAgentToken(authorization);
  if (token === null) return { ok: false, reason: "MISSING" };
  if (!token) return { ok: false, reason: "MALFORMED" };
  const digest = hashAgentToken(key, token);
  const record = await database.agentAccessToken.findUnique({
    where: { tokenHash: digest },
    select: {
      id: true,
      name: true,
      scopes: true,
      tokenHash: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, disabledAt: true } },
    },
  });
  if (
    !record ||
    !timingSafeEqual(Buffer.from(record.tokenHash, "utf8"), Buffer.from(digest, "utf8"))
  ) {
    return { ok: false, reason: "UNKNOWN" };
  }
  if (record.revokedAt) return { ok: false, reason: "REVOKED" };
  if (record.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
  if (record.user.disabledAt) return { ok: false, reason: "ACCOUNT_DISABLED" };
  if (
    !record.lastUsedAt ||
    now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS
  ) {
    // Conditional, so concurrent requests write lastUsedAt once per interval.
    await database.agentAccessToken
      .updateMany({
        where: {
          id: record.id,
          OR: [
            { lastUsedAt: null },
            { lastUsedAt: { lte: new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS) } },
          ],
        },
        data: { lastUsedAt: now },
      })
      .catch(() => undefined);
  }
  return {
    ok: true,
    principal: {
      user: { id: record.user.id },
      token: { id: record.id, name: record.name, scopes: orderedScopes(record.scopes) },
    },
  };
}

/** A telemetry-safe model id for an external agent, for example `external:claude-desktop`. */
export function externalAgentModelId(tokenName: string): string {
  const slug = tokenName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 55);
  return `external:${slug || "agent"}`;
}

/** Header carrying a single-use, in-process principal for the gateway's internal route calls. */
export const GATEWAY_PRINCIPAL_HEADER = "x-mandatepay-gateway-principal";

/**
 * The agent gateway reuses the cookie routes' own handlers (product search,
 * proposal creation) through Fastify `inject`. Each internal call carries a
 * fresh 256-bit nonce that names the token's owner, is valid for one request
 * within a few seconds, and never leaves this process. It is not a credential
 * an HTTP client can obtain.
 */
export function createGatewayPrincipals({ ttlMs = 15_000, capacity = 1_024 } = {}) {
  const pending = new Map<string, { userId: string; expiresAt: number }>();
  const prune = (now: number) => {
    for (const [nonce, entry] of pending) if (entry.expiresAt <= now) pending.delete(nonce);
  };
  return {
    issue(userId: string): string {
      const now = Date.now();
      prune(now);
      if (pending.size >= capacity) throw new Error("Gateway principal table is full.");
      const nonce = randomBytes(32).toString("base64url");
      pending.set(nonce, { userId, expiresAt: now + ttlMs });
      return nonce;
    },
    /** Returns the user id once; any later or unknown value returns null. */
    consume(value: string | string[] | undefined): string | null {
      const nonce = Array.isArray(value) ? value[0] : value;
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(nonce)) return null;
      const entry = pending.get(nonce);
      if (!entry) return null;
      pending.delete(nonce);
      return entry.expiresAt > Date.now() ? entry.userId : null;
    },
  };
}
export type GatewayPrincipals = ReturnType<typeof createGatewayPrincipals>;
