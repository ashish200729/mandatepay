import { z } from "zod";
import { Channel3ConfigurationError } from "./errors.js";

export const DEFAULT_CHANNEL3_BASE_URL = "https://api.trychannel3.com/v1";

export const Channel3FallbackModeSchema = z.enum(["disabled", "demo"]);
export type Channel3FallbackMode = z.infer<typeof Channel3FallbackModeSchema>;

const baseURLSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  }, "Base URL must be an HTTP(S) origin/path without credentials, query, or fragment.");

export const Channel3ConfigSchema = z
  .object({
    apiKey: z.string().trim().min(1).nullable().default(null),
    baseURL: baseURLSchema.default(DEFAULT_CHANNEL3_BASE_URL),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    maxRetries: z.number().int().nonnegative().max(2).default(1),
    fallbackMode: Channel3FallbackModeSchema.default("disabled"),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.fallbackMode === "disabled" && config.apiKey === null) {
      context.addIssue({ code: "custom", path: ["apiKey"], message: "API key is required." });
    }
  });

export type Channel3Config = z.output<typeof Channel3ConfigSchema>;

export function parseChannel3Config(input: unknown): Channel3Config {
  const parsed = Channel3ConfigSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    switch (path) {
      case "apiKey":
        throw new Channel3ConfigurationError("MISSING_API_KEY");
      case "baseURL":
        throw new Channel3ConfigurationError("INVALID_BASE_URL");
      case "timeoutMs":
        throw new Channel3ConfigurationError("INVALID_TIMEOUT");
      case "maxRetries":
        throw new Channel3ConfigurationError("INVALID_RETRY_LIMIT");
      case "fallbackMode":
        throw new Channel3ConfigurationError("INVALID_FALLBACK_MODE");
      default:
        throw new Channel3ConfigurationError("INVALID_BASE_URL");
    }
  }

  return parsed.data;
}

export function loadChannel3Config(env: NodeJS.ProcessEnv = process.env): Channel3Config {
  return parseChannel3Config({
    apiKey: env.CHANNEL3_API_KEY?.trim() || null,
    baseURL: env.CHANNEL3_BASE_URL ?? DEFAULT_CHANNEL3_BASE_URL,
    timeoutMs: env.CHANNEL3_TIMEOUT_MS === undefined ? undefined : Number(env.CHANNEL3_TIMEOUT_MS),
    maxRetries:
      env.CHANNEL3_MAX_RETRIES === undefined ? undefined : Number(env.CHANNEL3_MAX_RETRIES),
    fallbackMode: env.CHANNEL3_FALLBACK_MODE ?? "disabled",
  });
}
