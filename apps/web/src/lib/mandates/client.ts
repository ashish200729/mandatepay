import {
  PRODUCT_CONDITIONS,
  type CanonicalMandate,
  type MandateAction,
  type MandateDetail,
  type MandateParseResult,
  type ProductCondition,
} from "./types";

export class MandateApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MandateApiError";
  }
}

async function readResponse(response: Response) {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : "The mandate service could not complete that request.";
    throw new MandateApiError(message.slice(0, 240), response.status);
  }
  return payload;
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return readResponse(response);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The mandate response is missing ${field}.`);
  }
  return value;
}

function readStringList(value: unknown, field: string) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`The mandate response has invalid ${field}.`);
  }
  const values = value as string[];
  const normalized = values.map((item) => item.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`The mandate response has duplicate ${field}.`);
  }
  return values;
}

function readMinorUnits(value: unknown, field: string): number;
function readMinorUnits(value: unknown, field: string, optional: true): number | undefined;
function readMinorUnits(value: unknown, field: string, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new Error(`The mandate response is missing ${field}.`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The mandate response has invalid ${field}.`);
  }
  return value;
}

function readBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new Error(`The mandate response has invalid ${field}.`);
  return value;
}

function readUtcDate(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?$/u.test(value)
  ) {
    throw new Error(`The mandate response has invalid ${field}.`);
  }
  return value;
}

function readCanonical(value: unknown): CanonicalMandate {
  if (!isRecord(value)) throw new Error("The mandate response was not valid.");
  const rules = isRecord(value.rules) ? value.rules : value.canonicalRules;
  if (!isRecord(rules)) throw new Error("The mandate rules were not returned.");

  const conditions = rules.allowedConditions;
  if (
    !Array.isArray(conditions) ||
    conditions.length === 0 ||
    conditions.some((condition) => !PRODUCT_CONDITIONS.includes(condition as ProductCondition)) ||
    new Set(conditions).size !== conditions.length
  ) {
    throw new Error("The mandate response has invalid allowed conditions.");
  }

  const currency = readString(rules.currency, "currency");
  const timezone = readString(rules.timezone, "timezone");
  if (currency !== "USD" || timezone !== "UTC") {
    throw new Error("Only USD and UTC mandates are supported in this workspace.");
  }

  const transactionLimit = readMinorUnits(rules.transactionLimit, "transactionLimit");
  const autoSpendLimit = readMinorUnits(rules.autoSpendLimit, "autoSpendLimit");
  const quantityLimit = rules.quantityLimit;
  if (
    typeof quantityLimit !== "number" ||
    !Number.isSafeInteger(quantityLimit) ||
    quantityLimit < 1
  ) {
    throw new Error("The mandate response has invalid quantityLimit.");
  }

  return {
    title: readString(rules.title, "title"),
    productIntent: readString(rules.productIntent, "productIntent"),
    currency: "USD",
    timezone: "UTC",
    allowedBrands: readStringList(rules.allowedBrands, "allowedBrands"),
    blockedBrands: readStringList(rules.blockedBrands, "blockedBrands"),
    allowedCategories: readStringList(rules.allowedCategories, "allowedCategories"),
    blockedCategories: readStringList(rules.blockedCategories, "blockedCategories"),
    allowedConditions: conditions as ProductCondition[],
    autoSpendLimit,
    transactionLimit,
    dailyLimit: readMinorUnits(rules.dailyLimit, "dailyLimit", true),
    weeklyLimit: readMinorUnits(rules.weeklyLimit, "weeklyLimit", true),
    monthlyLimit: readMinorUnits(rules.monthlyLimit, "monthlyLimit", true),
    quantityLimit,
    allowedMerchants: readStringList(rules.allowedMerchants, "allowedMerchants"),
    blockedMerchants: readStringList(rules.blockedMerchants, "blockedMerchants"),
    newMerchantRequiresApproval: readBoolean(
      rules.newMerchantRequiresApproval,
      "newMerchantRequiresApproval",
    ),
    startsAt: readUtcDate(rules.startsAt, "startsAt"),
    expiresAt: readUtcDate(rules.expiresAt, "expiresAt"),
  };
}

export function readMandate(value: unknown): MandateDetail {
  const candidate = isRecord(value) && isRecord(value.mandate) ? value.mandate : value;
  if (
    !isRecord(candidate) ||
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.version !== "number" ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1 ||
    typeof candidate.originalPrompt !== "string"
  ) {
    throw new Error("The mandate response was not valid.");
  }

  return {
    id: candidate.id,
    title: candidate.title,
    status: candidate.status,
    version: candidate.version,
    originalPrompt: candidate.originalPrompt,
    rules: readCanonical(candidate),
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined,
    startsAt: typeof candidate.startsAt === "string" ? candidate.startsAt : undefined,
    expiresAt: typeof candidate.expiresAt === "string" ? candidate.expiresAt : undefined,
  };
}

export function createMandateRequestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `mandate-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export async function parseMandate(prompt: string): Promise<MandateParseResult> {
  const payload = await request("/api/mandates/parse", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  if (!isRecord(payload) || typeof payload.sourceOriginalPrompt !== "string") {
    throw new Error("The mandate parser returned an invalid response.");
  }
  if (payload.status === "ready") {
    return {
      status: "ready",
      sourceOriginalPrompt: payload.sourceOriginalPrompt,
      mandate: readCanonical({ rules: payload.mandate }),
    };
  }
  if (payload.status === "needs_clarification" && typeof payload.clarification === "string") {
    return {
      status: "needs_clarification",
      sourceOriginalPrompt: payload.sourceOriginalPrompt,
      clarification: payload.clarification,
      mandate: null,
    };
  }
  throw new Error("The mandate parser returned an invalid response.");
}

export async function listMandates() {
  const payload = await request("/api/mandates");
  if (!isRecord(payload) || !Array.isArray(payload.mandates)) {
    throw new Error("The mandate list response was not valid.");
  }
  return payload.mandates.map(readMandate);
}

export async function getMandate(id: string) {
  return readMandate(await request(`/api/mandates/${encodeURIComponent(id)}`));
}

export async function createMandate(
  originalPrompt: string,
  mandate: CanonicalMandate,
  creationRequestKey = createMandateRequestKey(),
) {
  return readMandate(
    await request("/api/mandates", {
      method: "POST",
      body: JSON.stringify({ originalPrompt, mandate, requestKey: creationRequestKey }),
    }),
  );
}

export async function updateMandate(
  id: string,
  version: number,
  originalPrompt: string,
  mandate: CanonicalMandate,
) {
  return readMandate(
    await request(`/api/mandates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ version, originalPrompt, mandate }),
    }),
  );
}

export async function transitionMandate(id: string, action: MandateAction, version: number) {
  return readMandate(
    await request(`/api/mandates/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  );
}
