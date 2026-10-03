import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

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
    API_URL: z.url().default("http://localhost:4000"),
    DATABASE_URL: optionalText,
    AUTH_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
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
    PAYPAL_ENV: z.literal("sandbox").default("sandbox"),
    PAYPAL_CLIENT_ID: optionalText,
    PAYPAL_CLIENT_SECRET: optionalText,
    PAYPAL_WEBHOOK_ID: optionalText,
    TOKEN_ENCRYPTION_KEY: optionalText,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production") {
      if (!value.AUTH_SECRET)
        context.addIssue({
          code: "custom",
          path: ["AUTH_SECRET"],
          message: "Production requires an auth secret.",
        });
      if (!value.DATABASE_URL)
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Production requires a database.",
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
