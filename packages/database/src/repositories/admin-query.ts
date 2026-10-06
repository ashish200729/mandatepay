import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AdminResourceIdSchema } from "@mandatepay/shared";
import { Prisma } from "../generated/prisma/client.js";
import { DatabaseError } from "../errors.js";
import { assertMinorUnits } from "../money.js";

export const WEBHOOK_LEASE_MS = 5 * 60_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;

export function iso(value: Date) {
  return value.toISOString();
}

export function minorNumber(value: bigint, field: string) {
  assertMinorUnits(value, field);
  return Number(value);
}

export function optionalMinor(value: bigint | null | undefined, field: string) {
  return value === null || value === undefined ? null : minorNumber(value, field);
}

export function ownerDto(user: { id: string; name: string | null; email: string }) {
  return { id: user.id, name: user.name, email: user.email };
}

export function queryBinding(value: object) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function encodeCursor(secret: string, payload: { at: string; id: string; binding: string }) {
  if (!secret || secret.length < 32)
    throw new DatabaseError("INVALID_STATE", "Cursor configuration is unavailable.");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

export function decodeCursor(secret: string, cursor: string, binding: string) {
  if (!secret || secret.length < 32)
    throw new DatabaseError("INVALID_STATE", "Cursor configuration is unavailable.");
  try {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac("sha256", secret).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new Error();
    const data = z
      .object({ at: z.iso.datetime(), id: AdminResourceIdSchema, binding: z.literal(binding) })
      .strict()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return { at: new Date(data.at), id: data.id };
  } catch {
    throw new DatabaseError("INVALID_DOMAIN_INPUT", "Invalid list cursor.");
  }
}

export function timestampPage(
  field: string,
  direction: "asc" | "desc",
  boundary?: { at: Date; id: string },
) {
  if (!boundary) return {};
  const compare = direction === "asc" ? "gt" : "lt";
  return {
    OR: [
      { [field]: { [compare]: boundary.at } },
      { [field]: boundary.at, id: { [compare]: boundary.id } },
    ],
  };
}

export function requireId(id: string, label = "record") {
  if (!AdminResourceIdSchema.safeParse(id).success)
    throw new DatabaseError("INVALID_DOMAIN_INPUT", `Invalid ${label} ID.`);
  return id;
}

export function sampleParent(includeSamples?: boolean): { isSample?: boolean } {
  return includeSamples ? {} : { isSample: false };
}

export function recoveryWhere(asOf: Date): Prisma.WebhookInboxWhereInput {
  const leaseCutoff = new Date(asOf.getTime() - WEBHOOK_LEASE_MS);
  return {
    provider: "paypal",
    signatureVerified: true,
    attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
    OR: [
      {
        status: "FAILED",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: asOf } }],
      },
      { status: "PROCESSING", updatedAt: { lte: leaseCutoff } },
    ],
  };
}

export function webhookDiagnostics(row: {
  signatureVerified: boolean;
  status: string;
  attempts: number;
  updatedAt: Date;
  nextAttemptAt: Date | null;
  lastError: string | null;
  asOf: Date;
}) {
  const leaseExpiresAt =
    row.status === "PROCESSING" ? new Date(row.updatedAt.getTime() + WEBHOOK_LEASE_MS) : null;
  const stale =
    row.signatureVerified &&
    row.status === "PROCESSING" &&
    row.updatedAt.getTime() <= row.asOf.getTime() - WEBHOOK_LEASE_MS;
  const exhausted =
    row.signatureVerified && row.status === "FAILED" && row.attempts >= WEBHOOK_MAX_ATTEMPTS;
  const dueFailed =
    row.status === "FAILED" && (!row.nextAttemptAt || row.nextAttemptAt <= row.asOf);
  const retryEligible =
    row.signatureVerified && row.attempts < WEBHOOK_MAX_ATTEMPTS && (dueFailed || stale);
  return { leaseExpiresAt, stale, retryEligible, exhausted };
}

export function providerIdsFromPayload(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const resource = (payload as Record<string, unknown>).resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return [];
  const ids: string[] = [];
  const record = resource as Record<string, unknown>;
  if (typeof record.id === "string") ids.push(record.id);
  const related =
    record.supplementary_data &&
    typeof record.supplementary_data === "object" &&
    !Array.isArray(record.supplementary_data)
      ? ((record.supplementary_data as Record<string, unknown>).related_ids as
          Record<string, unknown> | undefined)
      : undefined;
  if (related && typeof related.order_id === "string") ids.push(related.order_id);
  if (related && typeof related.refund_id === "string") ids.push(related.refund_id);
  return [...new Set(ids.filter((id) => /^[A-Za-z0-9._:-]{1,255}$/u.test(id)))].slice(0, 3);
}

export function defaultOverviewRange(asOf: Date) {
  return { from: new Date(asOf.getTime() - 30 * 86400_000), to: asOf };
}

export function activeMandateWhere(asOf: Date): Prisma.MandateWhereInput {
  return { status: "ACTIVE", startsAt: { lte: asOf }, expiresAt: { gt: asOf } };
}
