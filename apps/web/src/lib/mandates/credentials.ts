import { formatUsdLabel, formatUtcDate } from "./money";

/** Same-origin BFF path for MandatePay's public verification keys. */
export const MANDATE_JWKS_PATH = "/api/credentials/jwks";

export type CredentialKind =
  "OPEN_PAYMENT" | "OPEN_CHECKOUT" | "CLOSED_CHECKOUT" | "CLOSED_PAYMENT";

export type CredentialConstraint = { type: string } & Record<string, unknown>;

export interface MandateCredential {
  id: string;
  kind: CredentialKind;
  vct: string;
  kid: string;
  jwt: string;
  digest: string;
  checkoutHash: string | null;
  issuedAt: string;
  notBefore: string | null;
  expiresAt: string | null;
  verified: boolean;
  verificationReason: string | null;
  constraints: CredentialConstraint[];
  paymentAmount: { amount: number; currency: string } | null;
}

export interface MandateCredentialSet {
  mandateId: string;
  mandateStatus: string;
  version: number | null;
  issuer: string;
  credentials: MandateCredential[];
}

export interface CartMandate {
  proposalId: string;
  proposalStatus: string;
  checkoutHash: string | null;
  hashVerified: boolean;
  credentials: MandateCredential[];
}

export class CredentialApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CredentialApiError";
  }
}

const KINDS: readonly CredentialKind[] = [
  "OPEN_PAYMENT",
  "OPEN_CHECKOUT",
  "CLOSED_CHECKOUT",
  "CLOSED_PAYMENT",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

function readCredential(value: unknown): MandateCredential {
  if (!isRecord(value)) throw new Error("The credential response was not valid.");
  const kind = KINDS.find((item) => item === value.kind);
  const jwt = text(value.jwt);
  const kid = text(value.kid);
  const issuedAt = text(value.issuedAt);
  if (!kind || !jwt || !kid || !issuedAt || typeof value.verified !== "boolean") {
    throw new Error("The credential response was not valid.");
  }
  const amount = isRecord(value.paymentAmount) ? value.paymentAmount : null;
  return {
    id: text(value.id) ?? jwt.slice(-16),
    kind,
    vct: text(value.vct) ?? "",
    kid,
    jwt,
    digest: text(value.digest) ?? "",
    checkoutHash: text(value.checkoutHash),
    issuedAt,
    notBefore: text(value.notBefore),
    expiresAt: text(value.expiresAt),
    verified: value.verified,
    verificationReason: text(value.verificationReason),
    constraints: Array.isArray(value.constraints)
      ? (value.constraints.filter(
          (item) => isRecord(item) && typeof item.type === "string",
        ) as CredentialConstraint[])
      : [],
    paymentAmount:
      amount && typeof amount.amount === "number" && typeof amount.currency === "string"
        ? { amount: amount.amount, currency: amount.currency }
        : null,
  };
}

async function getJson(path: string) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new CredentialApiError(
      (typeof payload?.error === "string"
        ? payload.error
        : "Credentials could not be loaded."
      ).slice(0, 240),
      response.status,
    );
  }
  if (!payload) throw new Error("The credential response was empty.");
  return payload;
}

export function parseMandateCredentialSet(payload: Record<string, unknown>): MandateCredentialSet {
  return {
    mandateId: text(payload.mandateId) ?? "",
    mandateStatus: text(payload.mandateStatus) ?? "",
    version: typeof payload.version === "number" ? payload.version : null,
    issuer: text(payload.issuer) ?? "",
    credentials: Array.isArray(payload.credentials) ? payload.credentials.map(readCredential) : [],
  };
}

export function parseCartMandate(payload: Record<string, unknown>): CartMandate {
  return {
    proposalId: text(payload.proposalId) ?? "",
    proposalStatus: text(payload.proposalStatus) ?? "",
    checkoutHash: text(payload.checkoutHash),
    hashVerified: payload.hashVerified === true,
    credentials: Array.isArray(payload.credentials) ? payload.credentials.map(readCredential) : [],
  };
}

export async function getMandateCredentials(mandateId: string) {
  return parseMandateCredentialSet(
    await getJson(`/api/mandates/${encodeURIComponent(mandateId)}/credentials`),
  );
}

export async function getCartMandate(proposalId: string) {
  return parseCartMandate(
    await getJson(`/api/proposals/${encodeURIComponent(proposalId)}/credentials`),
  );
}

export function credentialLabel(kind: CredentialKind) {
  return {
    OPEN_PAYMENT: "Payment mandate (open)",
    OPEN_CHECKOUT: "Checkout mandate (open)",
    CLOSED_CHECKOUT: "Cart mandate (closed checkout)",
    CLOSED_PAYMENT: "Payment mandate (closed)",
  }[kind];
}

export function credentialFileName(credential: Pick<MandateCredential, "kind" | "id">) {
  return `mandatepay-${credential.kind.toLowerCase().replace("_", "-")}-${credential.id.slice(0, 8)}.jwt`;
}

/** First characters of a hash for display, never the whole credential. */
export function hashPrefix(hash: string | null, length = 12) {
  return hash ? hash.slice(0, length) : "—";
}

export interface ConstraintRow {
  key: string;
  rule: string;
  value: string;
  field: string;
  standard: "AP2 v0.2" | "MandatePay extension";
}

function names(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "None";
  return value
    .map((item) => (isRecord(item) ? text(item.name) : text(item)))
    .filter((item): item is string => Boolean(item))
    .join(", ");
}

function money(value: unknown) {
  return typeof value === "number" ? formatUsdLabel(value) : "—";
}

const WINDOW_UNIT: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month" };

const WINDOW_LABEL: Record<string, string> = {
  DAILY: "Daily budget",
  WEEKLY: "Weekly budget",
  MONTHLY: "Monthly budget",
};

/** Plain-language rows for the AP2-shaped constraint objects a credential carries. */
export function describeConstraint(constraint: CredentialConstraint, index = 0): ConstraintRow {
  const standard = constraint.type.startsWith("mandatepay.") ? "MandatePay extension" : "AP2 v0.2";
  const row = (rule: string, value: string): ConstraintRow => ({
    key: `${constraint.type}-${index}`,
    rule,
    value,
    field: constraint.type,
    standard,
  });
  switch (constraint.type) {
    case "payment.amount_range":
      return row("Per-purchase amount", `${money(constraint.min)} – ${money(constraint.max)}`);
    case "payment.execution_date":
      return row(
        "Valid period",
        `${formatUtcDate(text(constraint.not_before))} – ${formatUtcDate(text(constraint.not_after))}`,
      );
    case "payment.allowed_payees":
      return row("Allowed payees", names(constraint.allowed));
    case "checkout.allowed_merchants":
      return row("Allowed merchants", names(constraint.allowed));
    case "mandatepay.blocked_payees":
      return row("Blocked payees", names(constraint.blocked));
    case "mandatepay.blocked_merchants":
      return row("Blocked merchants", names(constraint.blocked));
    case "mandatepay.window_budget":
      return row(
        WINDOW_LABEL[text(constraint.window) ?? ""] ?? "Spending budget",
        `${money(constraint.max)} per ${WINDOW_UNIT[text(constraint.window) ?? ""] ?? "period"} (UTC)`,
      );
    case "mandatepay.approval_threshold":
      return row(
        "Automatic up to",
        `${money(constraint.max_autonomous)}; above needs your approval`,
      );
    case "mandatepay.new_merchant_requires_approval":
      return row(
        "New merchant",
        constraint.required === true ? "Needs your approval" : "No extra approval",
      );
    case "mandatepay.product_intent":
      return row("Product intent", text(constraint.description) ?? "—");
    case "mandatepay.max_quantity":
      return row("Maximum quantity", String(constraint.max ?? "—"));
    case "mandatepay.category_allowlist":
      return row("Allowed categories", names(constraint.allowed));
    case "mandatepay.category_blocklist":
      return row("Blocked categories", names(constraint.blocked));
    case "mandatepay.brand_allowlist":
      return row("Allowed brands", names(constraint.allowed));
    case "mandatepay.brand_blocklist":
      return row("Blocked brands", names(constraint.blocked));
    case "mandatepay.condition_allowlist":
      return row("Allowed conditions", names(constraint.allowed));
    default:
      return row(constraint.type, "Recorded in the credential");
  }
}
