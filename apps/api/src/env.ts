import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const base64url = /^[A-Za-z0-9_-]+$/u;

/** Shape-only check (no key import): a private JWK, or a list of public JWKs. */
function ecP256Jwks(text: string, kind: "private" | "public"): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const isJwk = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const jwk = value as Record<string, unknown>;
    const part = (field: string) => typeof jwk[field] === "string" && base64url.test(jwk[field]);
    return (
      jwk.kty === "EC" &&
      jwk.crv === "P-256" &&
      part("x") &&
      part("y") &&
      (kind === "private" ? part("d") : jwk.d === undefined)
    );
  };
  if (kind === "private") return isJwk(parsed);
  const keys =
    Array.isArray(parsed) || !parsed || typeof parsed !== "object"
      ? parsed
      : (parsed as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.every(isJwk);
}

export const environmentSchema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),
    ADMIN_ORIGIN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        }, "Use an HTTP(S) origin without credentials, path, query or fragment.")
        .optional(),
    ),
    API_URL: z.url().default("http://localhost:4000"),
    DATABASE_URL: optionalText,
    AUTH_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    AUTH_REQUIRE_EMAIL_VERIFICATION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    ),
    RESEND_API_KEY: optionalText,
    AUTH_EMAIL_FROM: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.email().optional(),
    ),
    // Shared only by the web/admin BFFs and the API; authenticates forwarded client IPs.
    INTERNAL_PROXY_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    // Optional proxy hop count for direct API traffic (for example a platform load balancer).
    TRUST_PROXY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(10).optional(),
    ),
    OPENAI_API_KEY: optionalText,
    OPENAI_MODEL: optionalText,
    OPENAI_BASE_URL: z
      .url()
      .default("https://api.openai.com/v1")
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Use an HTTP(S) API base URL without embedded credentials, query, or fragment."),
    CHANNEL3_API_KEY: optionalText,
    PRODUCT_DISCOVERY_MODE: z.enum(["demo", "channel3"]).default("demo"),
    // Sandbox by default; live PayPal is an explicit opt-in mapped to hosts in @mandatepay/paypal.
    PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
    PAYPAL_CLIENT_ID: optionalText,
    PAYPAL_CLIENT_SECRET: optionalText,
    PAYPAL_WEBHOOK_ID: optionalText,
    TOKEN_ENCRYPTION_KEY: optionalText,
    // EC P-256 private JWK (JSON) that signs AP2-shaped mandate credentials.
    MANDATE_SIGNING_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => ecP256Jwks(value, "private"), "Use an EC P-256 private JWK (JSON).")
        .optional(),
    ),
    // Retired public JWKs ({"keys":[...]} or an array) that still verify old credentials.
    MANDATE_SIGNING_PREVIOUS_JWKS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine((value) => ecP256Jwks(value, "public"), "Use public EC P-256 JWKs (JSON).")
        .optional(),
    ),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production") {
      if (value.ADMIN_ORIGIN && !value.ADMIN_ORIGIN.startsWith("https://"))
        context.addIssue({
          code: "custom",
          path: ["ADMIN_ORIGIN"],
          message: "Production admin requires HTTPS.",
        });
      if (value.AUTH_REQUIRE_EMAIL_VERIFICATION === false)
        context.addIssue({
          code: "custom",
          path: ["AUTH_REQUIRE_EMAIL_VERIFICATION"],
          message: "Production requires email verification.",
        });
      if (!value.RESEND_API_KEY)
        context.addIssue({
          code: "custom",
          path: ["RESEND_API_KEY"],
          message: "Production requires authentication email delivery.",
        });
      if (!value.AUTH_EMAIL_FROM)
        context.addIssue({
          code: "custom",
          path: ["AUTH_EMAIL_FROM"],
          message: "Production requires a verified sender address.",
        });
      if (!value.AUTH_SECRET)
        context.addIssue({
          code: "custom",
          path: ["AUTH_SECRET"],
          message: "Production requires an auth secret.",
        });
      if (!value.INTERNAL_PROXY_SECRET)
        context.addIssue({
          code: "custom",
          path: ["INTERNAL_PROXY_SECRET"],
          message: "Production requires a shared internal proxy secret.",
        });
      if (!value.DATABASE_URL)
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Production requires a database.",
        });
      if (!value.MANDATE_SIGNING_KEY)
        context.addIssue({
          code: "custom",
          path: ["MANDATE_SIGNING_KEY"],
          message: "Production requires a mandate credential signing key.",
        });
      if (!value.APP_URL.startsWith("https://"))
        context.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message: "Production requires HTTPS.",
        });
    }
  });

export const env = environmentSchema.parse(process.env);
