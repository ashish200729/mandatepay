import { createHash, randomUUID } from "node:crypto";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  AuditEntityType,
  AuditEventType,
  DatabaseError,
  MandateCredentialKind,
  MandateStatus,
  ProposalStatus,
  type DatabaseClient,
} from "@mandatepay/database";
import { CanonicalMandateSchema, type CanonicalMandate } from "@mandatepay/shared";

/*
 * AP2-shaped mandate credentials (v0.2 field names). MandatePay signs the user's
 * activated limits (open mandates) and each authorized cart (closed mandates) as
 * compact ES256 JWS. This is not AP2 certification or network acceptance: the
 * credentials are server-signed on the user's explicit activation/approval, carry
 * no agent key binding (`cnf`) yet, and use documented `mandatepay.*` constraint
 * types for rules AP2 v0.2 does not define. See docs/architecture/AP2_MANDATES.md.
 */

export const MANDATE_CREDENTIAL_TYP = "mandatepay+ap2-mandate+jwt";
export const MANDATE_CREDENTIAL_ALG = "ES256";
export const MANDATE_CREDENTIAL_PROFILE = "mandatepay.ap2-shaped.v0.2";
/** Compact JWS larger than this is never parsed. */
export const MAX_CREDENTIAL_LENGTH = 16_384;

export type CredentialKind = keyof typeof MandateCredentialKind;

export const CREDENTIAL_VCT: Record<CredentialKind, string> = {
  OPEN_PAYMENT: "mandate.payment.open.1",
  OPEN_CHECKOUT: "mandate.checkout.open.1",
  CLOSED_CHECKOUT: "mandate.checkout.1",
  CLOSED_PAYMENT: "mandate.payment.1",
};

const OPEN_KINDS = ["OPEN_PAYMENT", "OPEN_CHECKOUT"] as const satisfies readonly CredentialKind[];
const CLOSED_KINDS = [
  "CLOSED_CHECKOUT",
  "CLOSED_PAYMENT",
] as const satisfies readonly CredentialKind[];

/** Proposal states that were reached through AgentGuard ALLOW or a valid human approval. */
const AUTHORIZED_OR_LATER: readonly ProposalStatus[] = [
  ProposalStatus.AUTHORIZED,
  ProposalStatus.PAYPAL_ORDER_CREATED,
  ProposalStatus.PAYMENT_PENDING,
  ProposalStatus.COMPLETED,
];

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type PublicMandateJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

/** The key type jose returns for EC JWKs (WebCrypto CryptoKey). */
type JoseKey = Exclude<Awaited<ReturnType<typeof importJWK>>, Uint8Array>;

type VerificationKey = { kid: string; publicKey: JoseKey; publicJwk: PublicMandateJwk };

export interface MandateKeyring {
  readonly issuer: string;
  /** True when the key was generated for this process (development/test only). */
  readonly ephemeral: boolean;
  readonly current: VerificationKey & { privateKey: JoseKey };
  /** Current plus MANDATE_SIGNING_PREVIOUS_JWKS public keys, by kid. */
  readonly verificationKeys: ReadonlyMap<string, VerificationKey>;
}

export interface MandateSigningInput {
  /** EC P-256 private JWK as JSON (MANDATE_SIGNING_KEY). */
  readonly signingKey?: string | undefined;
  /** Public JWKs ({"keys":[...]} or an array) that still verify (MANDATE_SIGNING_PREVIOUS_JWKS). */
  readonly previousJwks?: string | undefined;
  /** `iss` claim; the API's public URL. */
  readonly issuer: string;
  readonly nodeEnv: "development" | "test" | "production";
}

export class MandateSigningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateSigningConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const base64url = /^[A-Za-z0-9_-]+$/u;

/** Shape check shared by env validation: an EC P-256 JWK, private (with `d`) or public. */
export function isEcP256Jwk(value: unknown, kind: "private" | "public"): value is JWK {
  if (!isRecord(value)) return false;
  if (value.kty !== "EC" || value.crv !== "P-256") return false;
  for (const field of ["x", "y"] as const) {
    if (typeof value[field] !== "string" || !base64url.test(value[field] as string)) return false;
  }
  if (kind === "private") return typeof value.d === "string" && base64url.test(value.d);
  return value.d === undefined;
}

export function parsePreviousJwks(text: string | undefined): JWK[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MandateSigningConfigurationError("MANDATE_SIGNING_PREVIOUS_JWKS is not valid JSON.");
  }
  const keys = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.keys : undefined;
  if (!Array.isArray(keys) || keys.some((key) => !isEcP256Jwk(key, "public"))) {
    throw new MandateSigningConfigurationError(
      "MANDATE_SIGNING_PREVIOUS_JWKS must contain only public EC P-256 JWKs.",
    );
  }
  return keys as JWK[];
}

function parseSigningJwk(text: string): JWK {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MandateSigningConfigurationError("MANDATE_SIGNING_KEY is not valid JSON.");
  }
  if (!isEcP256Jwk(parsed, "private")) {
    throw new MandateSigningConfigurationError(
      "MANDATE_SIGNING_KEY must be an EC P-256 private JWK.",
    );
  }
  return parsed;
}

async function publicKeyFor(jwk: JWK): Promise<VerificationKey> {
  const base = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } as const;
  const kid = await calculateJwkThumbprint(base, "sha256");
  const publicJwk: PublicMandateJwk = { ...base, kid, alg: "ES256", use: "sig" };
  const publicKey = (await importJWK(base, MANDATE_CREDENTIAL_ALG)) as JoseKey;
  return { kid, publicKey, publicJwk };
}

/** Generates a fresh private signing JWK (used by the keygen script and dev/test fallback). */
export async function generateMandateSigningJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair(MANDATE_CREDENTIAL_ALG, { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
}

export async function createMandateKeyring(
  input: MandateSigningInput,
  ephemeralJwk?: JWK,
): Promise<MandateKeyring> {
  let privateJwk: JWK;
  let ephemeral = false;
  if (input.signingKey) {
    privateJwk = parseSigningJwk(input.signingKey);
  } else if (input.nodeEnv === "production") {
    throw new MandateSigningConfigurationError("Production requires MANDATE_SIGNING_KEY.");
  } else {
    privateJwk = ephemeralJwk ?? (await generateMandateSigningJwk());
    ephemeral = true;
  }
  const current = await publicKeyFor(privateJwk);
  const privateKey = (await importJWK(
    { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    MANDATE_CREDENTIAL_ALG,
  )) as JoseKey;
  const verificationKeys = new Map<string, VerificationKey>([[current.kid, current]]);
  for (const previous of parsePreviousJwks(input.previousJwks)) {
    const key = await publicKeyFor(previous);
    if (!verificationKeys.has(key.kid)) verificationKeys.set(key.kid, key);
  }
  return {
    issuer: input.issuer,
    ephemeral,
    current: { ...current, privateKey },
    verificationKeys,
  };
}

/** Public JWKS: the current key first, then previous verification-only keys. */
export function publicJwks(keyring: MandateKeyring): { keys: PublicMandateJwk[] } {
  return { keys: [...keyring.verificationKeys.values()].map((key) => key.publicJwk) };
}

type Logger = { warn: (object: object, message: string) => void };

let configuredKey: string | null = null;
let configuredKeyring: Promise<MandateKeyring> | null = null;
let ephemeralSigningJwk: Promise<JWK> | null = null;
let logger: Logger | null = null;

/**
 * Process-wide keyring. Signing keys are process secrets, so every app instance
 * in a process shares them; a development/test process reuses one ephemeral key.
 */
export function configureMandateSigning(
  input: MandateSigningInput,
  log?: Logger,
): Promise<MandateKeyring> {
  if (log) logger = log;
  const key = JSON.stringify([
    input.issuer,
    input.nodeEnv,
    input.signingKey ?? "",
    input.previousJwks ?? "",
  ]);
  if (configuredKeyring && configuredKey === key) return configuredKeyring;
  configuredKey = key;
  if (!input.signingKey && input.nodeEnv !== "production") {
    const firstEphemeral = ephemeralSigningJwk === null;
    ephemeralSigningJwk ??= generateMandateSigningJwk();
    if (firstEphemeral) {
      log?.warn(
        { event: "mandate_signing_key_ephemeral" },
        "MANDATE_SIGNING_KEY is not set: mandate credentials use a temporary key that changes on restart.",
      );
    }
    configuredKeyring = ephemeralSigningJwk.then((jwk) => createMandateKeyring(input, jwk));
  } else {
    configuredKeyring = createMandateKeyring(input);
  }
  // A failed configuration is retried on the next call instead of being cached.
  configuredKeyring.catch(() => {
    if (configuredKey === key) {
      configuredKey = null;
      configuredKeyring = null;
    }
  });
  return configuredKeyring;
}

/** The configured keyring, or one derived from process.env for direct service callers. */
export function mandateKeyring(): Promise<MandateKeyring> {
  if (configuredKeyring) return configuredKeyring;
  const nodeEnv = process.env.NODE_ENV;
  return configureMandateSigning({
    signingKey: process.env.MANDATE_SIGNING_KEY || undefined,
    previousJwks: process.env.MANDATE_SIGNING_PREVIOUS_JWKS || undefined,
    issuer: process.env.API_URL || "http://localhost:4000",
    nodeEnv: nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
  });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, no whitespace. Only plain JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts only JSON values.");
}

function sha256Base64url(text: string) {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

export function credentialDigest(jwt: string) {
  return createHash("sha256").update(jwt, "utf8").digest("hex");
}

/** Opaque per-user subject: never the email or other PII. */
export function credentialSubject(userId: string) {
  return sha256Base64url(`mandatepay-subject:v1:${userId}`);
}

function epochSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

function safeInteger(value: bigint | number, field: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0 || BigInt(number) !== BigInt(value)) {
    throw new DatabaseError("INVALID_STATE", `Credential ${field} is not a safe minor-unit value.`);
  }
  return number;
}

export function merchantRef(name: string) {
  return { id: name.trim().toLocaleLowerCase("en-US"), name };
}

export type Constraint = { type: string } & Record<string, unknown>;

export interface OpenMandateFacts {
  readonly userId: string;
  readonly mandateId: string;
  readonly mandateVersionId: string;
  readonly version: number;
  readonly rules: CanonicalMandate;
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

/** AP2 `mandate.payment.open.1` constraints, plus documented MandatePay extensions. */
export function openPaymentConstraints(facts: OpenMandateFacts): Constraint[] {
  const { rules } = facts;
  const currency = rules.currency;
  const constraints: Constraint[] = [
    { type: "payment.amount_range", currency, min: 0, max: rules.transactionLimit },
    {
      type: "payment.execution_date",
      not_before: facts.startsAt.toISOString(),
      not_after: facts.expiresAt.toISOString(),
    },
  ];
  if (rules.allowedMerchants.length) {
    constraints.push({
      type: "payment.allowed_payees",
      allowed: rules.allowedMerchants.map(merchantRef),
    });
  }
  if (rules.blockedMerchants.length) {
    constraints.push({
      type: "mandatepay.blocked_payees",
      blocked: rules.blockedMerchants.map(merchantRef),
    });
  }
  for (const [window, max] of [
    ["DAILY", rules.dailyLimit],
    ["WEEKLY", rules.weeklyLimit],
    ["MONTHLY", rules.monthlyLimit],
  ] as const) {
    if (max !== undefined) {
      constraints.push({
        type: "mandatepay.window_budget",
        window,
        timezone: "UTC",
        currency,
        max,
      });
    }
  }
  constraints.push(
    { type: "mandatepay.approval_threshold", currency, max_autonomous: rules.autoSpendLimit },
    {
      type: "mandatepay.new_merchant_requires_approval",
      required: rules.newMerchantRequiresApproval,
    },
  );
  return constraints;
}

/** AP2 `mandate.checkout.open.1` constraints, plus documented MandatePay extensions. */
export function openCheckoutConstraints(facts: OpenMandateFacts): Constraint[] {
  const { rules } = facts;
  const constraints: Constraint[] = [];
  if (rules.allowedMerchants.length) {
    constraints.push({
      type: "checkout.allowed_merchants",
      allowed: rules.allowedMerchants.map(merchantRef),
    });
  }
  if (rules.blockedMerchants.length) {
    constraints.push({
      type: "mandatepay.blocked_merchants",
      blocked: rules.blockedMerchants.map(merchantRef),
    });
  }
  constraints.push(
    { type: "mandatepay.product_intent", description: rules.productIntent },
    { type: "mandatepay.max_quantity", max: rules.quantityLimit },
  );
  const lists = [
    ["mandatepay.category_allowlist", "allowed", rules.allowedCategories],
    ["mandatepay.category_blocklist", "blocked", rules.blockedCategories],
    ["mandatepay.brand_allowlist", "allowed", rules.allowedBrands],
    ["mandatepay.brand_blocklist", "blocked", rules.blockedBrands],
  ] as const;
  for (const [type, field, values] of lists) {
    if (values.length) constraints.push({ type, [field]: [...values] });
  }
  constraints.push({
    type: "mandatepay.condition_allowlist",
    allowed: [...rules.allowedConditions],
  });
  return constraints;
}

function mandateClaim(
  kind: CredentialKind,
  facts: { mandateId: string; mandateVersionId: string; version: number },
  extra: Record<string, unknown> = {},
) {
  return {
    profile: MANDATE_CREDENTIAL_PROFILE,
    kind,
    mandate_id: facts.mandateId,
    mandate_version_id: facts.mandateVersionId,
    mandate_version: facts.version,
    ...extra,
  };
}

/** Claims without iss/iat/jti: deterministic for the same mandate version. */
export function openMandateClaims(kind: (typeof OPEN_KINDS)[number], facts: OpenMandateFacts) {
  return {
    vct: CREDENTIAL_VCT[kind],
    sub: credentialSubject(facts.userId),
    nbf: epochSeconds(facts.startsAt),
    exp: epochSeconds(facts.expiresAt),
    constraints:
      kind === "OPEN_PAYMENT" ? openPaymentConstraints(facts) : openCheckoutConstraints(facts),
    mandatepay: mandateClaim(kind, facts, { title: facts.rules.title }),
  };
}

/** The authoritative cart the closed mandates bind, in integer minor units. */
export interface CheckoutFacts {
  readonly proposal_id: string;
  readonly mandate_version_id: string;
  readonly product_external_id: string;
  readonly source: string;
  readonly merchant: string;
  readonly title: string;
  readonly condition: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly shipping: number;
  readonly tax: number;
  readonly total: number;
  readonly currency: string;
}

export interface CheckoutProposalRecord {
  id: string;
  mandateVersionId: string;
  quantity: number;
  shipping: bigint;
  tax: bigint;
  total: bigint;
  currency: string;
  productSnapshot: {
    externalId: string;
    source: string;
    merchant: string;
    title: string;
    condition: string;
    price: bigint;
  };
}

export function checkoutFacts(proposal: CheckoutProposalRecord): CheckoutFacts {
  const product = proposal.productSnapshot;
  return {
    proposal_id: proposal.id,
    mandate_version_id: proposal.mandateVersionId,
    product_external_id: product.externalId,
    source: product.source,
    merchant: product.merchant,
    title: product.title,
    condition: product.condition,
    quantity: safeInteger(proposal.quantity, "quantity"),
    unit_price: safeInteger(product.price, "unit price"),
    shipping: safeInteger(proposal.shipping, "shipping"),
    tax: safeInteger(proposal.tax, "tax"),
    total: safeInteger(proposal.total, "total"),
    currency: proposal.currency,
  };
}

/** base64url(sha256(canonical JSON of the cart facts)). */
export function computeCheckoutHash(facts: CheckoutFacts): string {
  return sha256Base64url(canonicalJson(facts));
}

export interface ClosedMandateFacts {
  readonly userId: string;
  readonly mandateId: string;
  readonly version: number;
  readonly checkout: CheckoutFacts;
  readonly expiresAt: Date;
  /** Digests of the open credentials for the same mandate version, when issued. */
  readonly openMandateDigests?: Partial<Record<"payment" | "checkout", string>>;
}

export function closedMandateClaims(
  kind: (typeof CLOSED_KINDS)[number],
  facts: ClosedMandateFacts,
) {
  const checkoutHash = computeCheckoutHash(facts.checkout);
  const common = {
    vct: CREDENTIAL_VCT[kind],
    sub: credentialSubject(facts.userId),
    exp: epochSeconds(facts.expiresAt),
    mandatepay: mandateClaim(
      kind,
      {
        mandateId: facts.mandateId,
        mandateVersionId: facts.checkout.mandate_version_id,
        version: facts.version,
      },
      {
        proposal_id: facts.checkout.proposal_id,
        ...(facts.openMandateDigests && Object.keys(facts.openMandateDigests).length
          ? { open_mandate_digests: facts.openMandateDigests }
          : {}),
      },
    ),
  };
  if (kind === "CLOSED_CHECKOUT") {
    // AP2 hashes a merchant-signed checkout_jwt. Demo merchants do not sign
    // carts, so the canonical cart itself is disclosed and hashed instead.
    return { ...common, checkout_hash: checkoutHash, mandatepay_checkout: facts.checkout };
  }
  return {
    ...common,
    transaction_id: checkoutHash,
    payee: merchantRef(facts.checkout.merchant),
    payment_amount: { amount: facts.checkout.total, currency: facts.checkout.currency },
    payment_instrument: {
      id: "paypal",
      type: "paypal",
      description: "PayPal (buyer-approved checkout or saved PayPal)",
    },
  };
}

export async function signMandateCredential(
  keyring: MandateKeyring,
  claims: Record<string, unknown>,
  now = new Date(),
): Promise<string> {
  const iat = epochSeconds(now);
  const payload: JWTPayload = {
    iss: keyring.issuer,
    iat,
    nbf: iat,
    jti: randomUUID(),
    ...claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: MANDATE_CREDENTIAL_ALG,
      typ: MANDATE_CREDENTIAL_TYP,
      kid: keyring.current.kid,
    })
    .sign(keyring.current.privateKey);
}

// ---------------------------------------------------------------------------
// Verification (public keys only)
// ---------------------------------------------------------------------------

export type VerificationReason =
  | "MALFORMED"
  | "UNSUPPORTED_ALGORITHM"
  | "WRONG_TYPE"
  | "UNKNOWN_KEY"
  | "SIGNATURE_INVALID"
  | "WRONG_ISSUER"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "UNKNOWN_MANDATE_TYPE"
  | "CHECKOUT_HASH_MISMATCH";

export interface CredentialClaimsSummary {
  vct: string | null;
  iss: string | null;
  sub: string | null;
  iat: number | null;
  nbf: number | null;
  exp: number | null;
  jti: string | null;
  mandateId: string | null;
  mandateVersionId: string | null;
  mandateVersion: number | null;
  proposalId: string | null;
  checkoutHash: string | null;
  paymentAmount: { amount: number; currency: string } | null;
  constraints: Constraint[];
}

export interface VerificationResult {
  valid: boolean;
  kid: string | null;
  kind: CredentialKind | null;
  reason: VerificationReason | null;
  claims: CredentialClaimsSummary | null;
}

function kindForVct(vct: unknown): CredentialKind | null {
  for (const [kind, value] of Object.entries(CREDENTIAL_VCT)) {
    if (value === vct) return kind as CredentialKind;
  }
  return null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export function summarizeClaims(payload: JWTPayload): CredentialClaimsSummary {
  const mandatepay = isRecord(payload.mandatepay) ? payload.mandatepay : {};
  const amount = isRecord(payload.payment_amount) ? payload.payment_amount : null;
  return {
    vct: text(payload.vct),
    iss: text(payload.iss),
    sub: text(payload.sub),
    iat: integer(payload.iat),
    nbf: integer(payload.nbf),
    exp: integer(payload.exp),
    jti: text(payload.jti),
    mandateId: text(mandatepay.mandate_id),
    mandateVersionId: text(mandatepay.mandate_version_id),
    mandateVersion: integer(mandatepay.mandate_version),
    proposalId: text(mandatepay.proposal_id),
    checkoutHash: text(payload.checkout_hash) ?? text(payload.transaction_id),
    paymentAmount:
      amount && integer(amount.amount) !== null && typeof amount.currency === "string"
        ? { amount: amount.amount as number, currency: amount.currency }
        : null,
    constraints: Array.isArray(payload.constraints)
      ? (payload.constraints.filter(
          (item) => isRecord(item) && typeof item.type === "string",
        ) as Constraint[])
      : [],
  };
}

function invalid(
  reason: VerificationReason,
  kid: string | null = null,
  kind: CredentialKind | null = null,
  claims: CredentialClaimsSummary | null = null,
): VerificationResult {
  return { valid: false, kid, kind, reason, claims };
}

export interface VerifyOptions {
  /**
   * Time used for nbf/exp. Payment enforcement passes the issuance time:
   * validity windows are AgentGuard's job at revalidation, while enforcement
   * checks only that the cart is the one that was signed.
   */
  readonly currentDate?: Date;
}

export async function verifyMandateCredential(
  keyring: MandateKeyring,
  jwt: string,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  if (
    typeof jwt !== "string" ||
    jwt.length > MAX_CREDENTIAL_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(jwt)
  ) {
    return invalid("MALFORMED");
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jwt);
  } catch {
    return invalid("MALFORMED");
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (header.alg !== MANDATE_CREDENTIAL_ALG) return invalid("UNSUPPORTED_ALGORITHM", kid);
  if (header.typ !== MANDATE_CREDENTIAL_TYP) return invalid("WRONG_TYPE", kid);
  const key = kid ? keyring.verificationKeys.get(kid) : undefined;
  if (!key) return invalid("UNKNOWN_KEY", kid);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(jwt, key.publicKey, {
      algorithms: [MANDATE_CREDENTIAL_ALG],
      typ: MANDATE_CREDENTIAL_TYP,
      issuer: keyring.issuer,
      currentDate: options.currentDate,
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const claim = (error as { claim?: unknown }).claim;
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return invalid("SIGNATURE_INVALID", kid);
    if (code === "ERR_JWT_EXPIRED") return invalid("EXPIRED", kid);
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      if (claim === "iss") return invalid("WRONG_ISSUER", kid);
      if (claim === "nbf" || claim === "iat") return invalid("NOT_YET_VALID", kid);
      if (claim === "typ") return invalid("WRONG_TYPE", kid);
    }
    return invalid("MALFORMED", kid);
  }
  const claims = summarizeClaims(payload);
  const kind = kindForVct(payload.vct);
  if (!kind) return invalid("UNKNOWN_MANDATE_TYPE", kid, null, claims);
  if (kind === "CLOSED_CHECKOUT") {
    const cart = payload.mandatepay_checkout;
    let recomputed: string | null = null;
    try {
      recomputed = isRecord(cart) ? sha256Base64url(canonicalJson(cart)) : null;
    } catch {
      recomputed = null;
    }
    if (!recomputed || recomputed !== payload.checkout_hash) {
      return invalid("CHECKOUT_HASH_MISMATCH", kid, kind, claims);
    }
  }
  return { valid: true, kid, kind, reason: null, claims };
}

// ---------------------------------------------------------------------------
// Persistence and issuance
// ---------------------------------------------------------------------------

type CredentialRow = {
  id: string;
  userId: string;
  mandateId: string;
  mandateVersionId: string;
  proposalId: string | null;
  kind: CredentialKind;
  kid: string;
  jwt: string;
  digest: string;
  checkoutHash: string | null;
  issuedAt: Date;
};

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

async function persistCredential(
  database: DatabaseClient,
  row: Omit<CredentialRow, "id" | "issuedAt" | "digest"> & { issuedAt: Date },
  find: () => Promise<CredentialRow | null>,
): Promise<CredentialRow> {
  const digest = credentialDigest(row.jwt);
  try {
    return (await database.$transaction(async (tx) => {
      const created = await tx.mandateCredential.create({ data: { ...row, digest } });
      await tx.auditEvent.create({
        data: {
          userId: row.userId,
          eventType: AuditEventType.MANDATE_CREDENTIAL_ISSUED,
          entityType: row.proposalId
            ? AuditEntityType.PURCHASE_PROPOSAL
            : AuditEntityType.MANDATE_VERSION,
          entityId: row.proposalId ?? row.mandateVersionId,
          dedupeKey: `mandate-credential:${row.proposalId ?? row.mandateVersionId}:${row.kind}`,
          payload: {
            mandateId: row.mandateId,
            mandateVersionId: row.mandateVersionId,
            proposalId: row.proposalId,
            kind: row.kind,
            vct: CREDENTIAL_VCT[row.kind],
            kid: row.kid,
            digest,
            checkoutHash: row.checkoutHash,
          },
        },
      });
      return created;
    })) as CredentialRow;
  } catch (error) {
    // A concurrent issuer won; its credential is the one of record.
    if (!isUniqueViolation(error)) throw error;
    const existing = await find();
    if (!existing) throw error;
    return existing;
  }
}

function findOpen(database: DatabaseClient, mandateVersionId: string, kind: CredentialKind) {
  return database.mandateCredential.findFirst({
    where: { mandateVersionId, kind, proposalId: null },
  }) as Promise<CredentialRow | null>;
}

function findClosed(database: DatabaseClient, proposalId: string, kind: CredentialKind) {
  return database.mandateCredential.findFirst({
    where: { proposalId, kind },
  }) as Promise<CredentialRow | null>;
}

async function loadOpenFacts(database: DatabaseClient, mandateId: string, userId?: string) {
  const mandate = await database.mandate.findFirst({
    where: { id: mandateId, ...(userId ? { userId } : {}) },
    include: { activeVersion: true },
  });
  if (!mandate) throw new DatabaseError("NOT_FOUND", "Mandate was not found for this user.");
  const version = mandate.activeVersion;
  if (!version) return { mandate, facts: null };
  const rules = CanonicalMandateSchema.safeParse(version.canonicalRules);
  if (!rules.success) {
    throw new DatabaseError("INVALID_STATE", "Mandate canonical snapshot is invalid.");
  }
  const facts: OpenMandateFacts = {
    userId: mandate.userId,
    mandateId: mandate.id,
    mandateVersionId: version.id,
    version: version.version,
    rules: rules.data,
    startsAt: version.startsAt,
    expiresAt: version.expiresAt,
  };
  return { mandate, facts };
}

/**
 * Issues (idempotently) the open payment and checkout credentials for the
 * mandate's active version. Only an ACTIVE mandate is signed: the signature
 * records the user's explicit activation of exactly these limits.
 */
export async function issueOpenMandateCredentials(
  database: DatabaseClient,
  mandateId: string,
  userId?: string,
): Promise<CredentialRow[]> {
  const { mandate, facts } = await loadOpenFacts(database, mandateId, userId);
  if (!facts) return [];
  const rows: CredentialRow[] = [];
  for (const kind of OPEN_KINDS) {
    const existing = await findOpen(database, facts.mandateVersionId, kind);
    if (existing) {
      rows.push(existing);
      continue;
    }
    if (mandate.status !== MandateStatus.ACTIVE) continue;
    const keyring = await mandateKeyring();
    const now = new Date();
    const jwt = await signMandateCredential(keyring, openMandateClaims(kind, facts), now);
    rows.push(
      await persistCredential(
        database,
        {
          userId: facts.userId,
          mandateId: facts.mandateId,
          mandateVersionId: facts.mandateVersionId,
          proposalId: null,
          kind,
          kid: keyring.current.kid,
          jwt,
          checkoutHash: null,
          issuedAt: now,
        },
        () => findOpen(database, facts.mandateVersionId, kind),
      ),
    );
  }
  return rows;
}

const closedProposalInclude = {
  productSnapshot: true,
  mandateVersion: true,
} as const;

async function loadClosedProposal(database: DatabaseClient, proposalId: string, userId?: string) {
  const proposal = await database.purchaseProposal.findFirst({
    where: { id: proposalId, ...(userId ? { userId } : {}) },
    include: closedProposalInclude,
  });
  if (!proposal) throw new DatabaseError("NOT_FOUND", "Proposal was not found for this user.");
  return proposal;
}

/**
 * Issues (idempotently) the closed checkout and payment credentials that bind
 * an authorized proposal's exact cart. Never signs a proposal that has not
 * passed AgentGuard ALLOW or an explicit human approval.
 */
export async function issueClosedMandateCredentials(
  database: DatabaseClient,
  proposalId: string,
  userId?: string,
): Promise<CredentialRow[]> {
  const proposal = await loadClosedProposal(database, proposalId, userId);
  const existing = await Promise.all(
    CLOSED_KINDS.map((kind) => findClosed(database, proposalId, kind)),
  );
  if (existing.every((row) => row !== null)) return existing as CredentialRow[];
  if (!AUTHORIZED_OR_LATER.includes(proposal.status) || proposal.isSample) {
    return existing.filter((row): row is CredentialRow => row !== null);
  }
  const checkout = checkoutFacts(proposal);
  const checkoutHash = computeCheckoutHash(checkout);
  const openRows = await Promise.all(
    OPEN_KINDS.map((kind) => findOpen(database, proposal.mandateVersionId, kind)),
  );
  const openMandateDigests: Partial<Record<"payment" | "checkout", string>> = {};
  if (openRows[0]) openMandateDigests.payment = openRows[0].digest;
  if (openRows[1]) openMandateDigests.checkout = openRows[1].digest;
  const facts: ClosedMandateFacts = {
    userId: proposal.userId,
    mandateId: proposal.mandateId,
    version: proposal.mandateVersion.version,
    checkout,
    expiresAt: proposal.mandateVersion.expiresAt,
    openMandateDigests,
  };
  const rows: CredentialRow[] = [];
  for (const [index, kind] of CLOSED_KINDS.entries()) {
    const current = existing[index];
    if (current) {
      rows.push(current);
      continue;
    }
    const keyring = await mandateKeyring();
    const now = new Date();
    const jwt = await signMandateCredential(keyring, closedMandateClaims(kind, facts), now);
    rows.push(
      await persistCredential(
        database,
        {
          userId: proposal.userId,
          mandateId: proposal.mandateId,
          mandateVersionId: proposal.mandateVersionId,
          proposalId,
          kind,
          kid: keyring.current.kid,
          jwt,
          checkoutHash,
          issuedAt: now,
        },
        () => findClosed(database, proposalId, kind),
      ),
    );
  }
  return rows;
}

function report(event: string, error: unknown, ids: Record<string, string>) {
  logger?.warn(
    { event, ...ids, error: error instanceof Error ? error.name : "UnknownError" },
    "Mandate credential issuance failed; it will be retried lazily.",
  );
}

/** After-commit hook: issuance must never fail or roll back activation. */
export async function issueOpenCredentialsAfterCommit(
  database: DatabaseClient,
  mandateId: string,
  userId: string,
) {
  try {
    await issueOpenMandateCredentials(database, mandateId, userId);
  } catch (error) {
    report("mandate_credential_issue_failed", error, { mandateId });
  }
}

/** After-commit hook for an AUTHORIZED proposal; payment enforcement retries lazily. */
export async function issueClosedCredentialsAfterCommit(
  database: DatabaseClient,
  proposalId: string,
  userId: string,
) {
  try {
    await issueClosedMandateCredentials(database, proposalId, userId);
  } catch (error) {
    report("cart_mandate_issue_failed", error, { proposalId });
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface CredentialView {
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
  verificationReason: VerificationReason | null;
  constraints: Constraint[];
  paymentAmount: { amount: number; currency: string } | null;
}

function isoFromEpoch(value: number | null) {
  return value === null ? null : new Date(value * 1000).toISOString();
}

async function toView(keyring: MandateKeyring, row: CredentialRow): Promise<CredentialView> {
  // Signature, type, key and issuer are checked; time windows are reported separately.
  const result = await verifyMandateCredential(keyring, row.jwt, { currentDate: row.issuedAt });
  return {
    id: row.id,
    kind: row.kind,
    vct: CREDENTIAL_VCT[row.kind],
    kid: row.kid,
    jwt: row.jwt,
    digest: row.digest,
    checkoutHash: row.checkoutHash,
    issuedAt: row.issuedAt.toISOString(),
    notBefore: isoFromEpoch(result.claims?.nbf ?? null),
    expiresAt: isoFromEpoch(result.claims?.exp ?? null),
    verified: result.valid && result.kind === row.kind,
    verificationReason:
      result.valid && result.kind !== row.kind ? "UNKNOWN_MANDATE_TYPE" : result.reason,
    constraints: result.claims?.constraints ?? [],
    paymentAmount: result.claims?.paymentAmount ?? null,
  };
}

export async function readMandateCredentials(
  database: DatabaseClient,
  userId: string,
  mandateId: string,
) {
  const { mandate, facts } = await loadOpenFacts(database, mandateId, userId);
  const rows = facts
    ? mandate.status === MandateStatus.ACTIVE
      ? await issueOpenMandateCredentials(database, mandateId, userId)
      : (
          await Promise.all(
            OPEN_KINDS.map((kind) => findOpen(database, facts.mandateVersionId, kind)),
          )
        ).filter((row): row is CredentialRow => row !== null)
    : [];
  const keyring = await mandateKeyring();
  return {
    mandateId: mandate.id,
    mandateStatus: mandate.status,
    mandateVersionId: facts?.mandateVersionId ?? null,
    version: facts?.version ?? null,
    issuer: keyring.issuer,
    profile: MANDATE_CREDENTIAL_PROFILE,
    credentials: await Promise.all(rows.map((row) => toView(keyring, row))),
  };
}

export async function readProposalCredentials(
  database: DatabaseClient,
  userId: string,
  proposalId: string,
) {
  const proposal = await loadClosedProposal(database, proposalId, userId);
  const rows = await issueClosedMandateCredentials(database, proposalId, userId);
  const keyring = await mandateKeyring();
  const views = await Promise.all(rows.map((row) => toView(keyring, row)));
  let expectedHash: string | null = null;
  try {
    expectedHash = computeCheckoutHash(checkoutFacts(proposal));
  } catch {
    expectedHash = null;
  }
  const hashVerified =
    views.length === CLOSED_KINDS.length &&
    expectedHash !== null &&
    views.every((view) => view.verified && view.checkoutHash === expectedHash);
  return {
    proposalId,
    proposalStatus: proposal.status,
    issuer: keyring.issuer,
    profile: MANDATE_CREDENTIAL_PROFILE,
    checkoutHash: views[0]?.checkoutHash ?? null,
    hashVerified,
    credentials: views,
  };
}

// ---------------------------------------------------------------------------
// Payment enforcement
// ---------------------------------------------------------------------------

export type CartMandateMismatchReason =
  | "CART_MANDATE_MISSING"
  | "CART_MANDATE_SIGNATURE_INVALID"
  | "CART_MANDATE_BINDING_INVALID"
  | "CART_HASH_MISMATCH"
  | "PAYMENT_AMOUNT_MISMATCH";

export class CartMandateMismatchError extends Error {
  readonly code = "CART_MANDATE_MISMATCH";
  constructor(readonly reason: CartMandateMismatchReason) {
    super("The cart no longer matches the signed cart mandate.");
    this.name = "CartMandateMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function cartMismatchReason(
  database: DatabaseClient,
  userId: string,
  proposalId: string,
  payment: { amount: bigint; currency: string } | undefined,
): Promise<{
  reason: CartMandateMismatchReason | null;
  expected: string | null;
  signed: string | null;
}> {
  const proposal = await loadClosedProposal(database, proposalId, userId);
  let rows = (
    await Promise.all(CLOSED_KINDS.map((kind) => findClosed(database, proposalId, kind)))
  ).filter((row): row is CredentialRow => row !== null);
  if (rows.length !== CLOSED_KINDS.length) {
    // One lazy attempt covers an after-commit hook that failed.
    try {
      rows = await issueClosedMandateCredentials(database, proposalId, userId);
    } catch {
      // Treated as missing below.
    }
  }
  const checkout = rows.find((row) => row.kind === "CLOSED_CHECKOUT");
  const paymentRow = rows.find((row) => row.kind === "CLOSED_PAYMENT");
  if (!checkout || !paymentRow)
    return { reason: "CART_MANDATE_MISSING", expected: null, signed: null };

  let expected: string;
  let facts: CheckoutFacts;
  try {
    facts = checkoutFacts(proposal);
    expected = computeCheckoutHash(facts);
  } catch {
    return { reason: "CART_HASH_MISMATCH", expected: null, signed: checkout.checkoutHash };
  }
  const keyring = await mandateKeyring();
  const [checkoutResult, paymentResult] = await Promise.all([
    verifyMandateCredential(keyring, checkout.jwt, { currentDate: checkout.issuedAt }),
    verifyMandateCredential(keyring, paymentRow.jwt, { currentDate: paymentRow.issuedAt }),
  ]);
  const signed = checkoutResult.claims?.checkoutHash ?? checkout.checkoutHash;
  if (
    !checkoutResult.valid ||
    !paymentResult.valid ||
    checkoutResult.kind !== "CLOSED_CHECKOUT" ||
    paymentResult.kind !== "CLOSED_PAYMENT"
  ) {
    return { reason: "CART_MANDATE_SIGNATURE_INVALID", expected, signed };
  }
  if (
    checkoutResult.claims?.proposalId !== proposalId ||
    paymentResult.claims?.proposalId !== proposalId ||
    checkoutResult.claims.sub !== credentialSubject(userId) ||
    checkoutResult.claims.mandateVersionId !== proposal.mandateVersionId
  ) {
    return { reason: "CART_MANDATE_BINDING_INVALID", expected, signed };
  }
  if (
    signed !== expected ||
    paymentResult.claims.checkoutHash !== expected ||
    checkout.checkoutHash !== expected
  ) {
    return { reason: "CART_HASH_MISMATCH", expected, signed };
  }
  const amount = paymentResult.claims.paymentAmount;
  if (
    !amount ||
    amount.amount !== facts.total ||
    amount.currency !== facts.currency ||
    (payment && (payment.amount !== BigInt(amount.amount) || payment.currency !== amount.currency))
  ) {
    return { reason: "PAYMENT_AMOUNT_MISMATCH", expected, signed };
  }
  return { reason: null, expected, signed };
}

/**
 * Defense in depth against cart tampering: immediately before a PayPal order,
 * the closed cart mandate must verify with MandatePay's public keys and its
 * checkout hash must equal one recomputed from authoritative server facts.
 * Throws CartMandateMismatchError (after an audit event) when it does not.
 */
export async function assertCartMandate(
  database: DatabaseClient,
  userId: string,
  proposalId: string,
  payment?: { amount: bigint; currency: string },
): Promise<void> {
  const { reason, expected, signed } = await cartMismatchReason(
    database,
    userId,
    proposalId,
    payment,
  );
  if (!reason) return;
  const proposal = await database.purchaseProposal.findFirst({
    where: { id: proposalId, userId },
    select: { mandateId: true, mandateVersionId: true },
  });
  await database.auditEvent.create({
    data: {
      userId,
      eventType: AuditEventType.CART_MANDATE_MISMATCH,
      entityType: AuditEntityType.PURCHASE_PROPOSAL,
      entityId: proposalId,
      payload: {
        proposalId,
        mandateId: proposal?.mandateId ?? null,
        mandateVersionId: proposal?.mandateVersionId ?? null,
        reason,
        expectedCheckoutHash: expected,
        signedCheckoutHash: signed,
        paypalCalled: false,
      },
    },
  });
  throw new CartMandateMismatchError(reason);
}
