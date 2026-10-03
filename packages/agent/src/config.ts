import OpenAI from "openai";
import { z } from "zod";
import { OpenAIConfigurationError } from "./errors.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export const OpenAIResponseModeSchema = z.enum(["json_schema", "json_object"]);
export type OpenAIResponseMode = z.infer<typeof OpenAIResponseModeSchema>;

export const OpenAIReasoningEffortSchema = z.enum(["low", "medium", "high"]).nullable();
export type OpenAIReasoningEffort = z.infer<typeof OpenAIReasoningEffortSchema>;

const baseURLSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      !parsed.search &&
      !parsed.hash
    );
  }, "Base URL must not contain credentials.");

export const OpenAIParserConfigSchema = z
  .object({
    apiKey: z.string().refine((value) => value.trim().length > 0),
    model: z.string().trim().min(1),
    baseURL: baseURLSchema.default(DEFAULT_OPENAI_BASE_URL),
    responseMode: OpenAIResponseModeSchema.default("json_schema"),
    timeoutMs: z.number().int().positive().max(120_000).default(20_000),
    maxRetries: z.number().int().nonnegative().max(2).default(1),
    maxOutputTokens: z.number().int().min(128).max(8_192).default(2_048),
    reasoningEffort: OpenAIReasoningEffortSchema.default(null),
  })
  .strict();

export type OpenAIParserConfig = z.output<typeof OpenAIParserConfigSchema>;

function configurationIssue(path: string | undefined): OpenAIConfigurationError {
  switch (path) {
    case "apiKey":
      return new OpenAIConfigurationError("MISSING_API_KEY");
    case "model":
      return new OpenAIConfigurationError("MISSING_MODEL");
    case "baseURL":
      return new OpenAIConfigurationError("INVALID_BASE_URL");
    case "responseMode":
      return new OpenAIConfigurationError("INVALID_RESPONSE_MODE");
    case "timeoutMs":
      return new OpenAIConfigurationError("INVALID_TIMEOUT");
    case "maxRetries":
      return new OpenAIConfigurationError("INVALID_RETRY_LIMIT");
    case "maxOutputTokens":
      return new OpenAIConfigurationError("INVALID_OUTPUT_TOKEN_BUDGET");
    case "reasoningEffort":
      return new OpenAIConfigurationError("INVALID_REASONING_EFFORT");
    default:
      return new OpenAIConfigurationError("INVALID_BASE_URL");
  }
}

export function parseOpenAIConfig(input: unknown): OpenAIParserConfig {
  const parsed = OpenAIParserConfigSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    throw configurationIssue(typeof path === "string" ? path : undefined);
  }

  return parsed.data;
}

export function loadOpenAIConfig(env: NodeJS.ProcessEnv = process.env): OpenAIParserConfig {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim().length === 0) {
    throw new OpenAIConfigurationError("MISSING_API_KEY");
  }
  if (!env.OPENAI_MODEL || env.OPENAI_MODEL.trim().length === 0) {
    throw new OpenAIConfigurationError("MISSING_MODEL");
  }

  return parseOpenAIConfig({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    baseURL: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    responseMode: env.OPENAI_RESPONSE_MODE ?? "json_schema",
    timeoutMs: env.OPENAI_TIMEOUT_MS === undefined ? undefined : Number(env.OPENAI_TIMEOUT_MS),
    maxRetries: env.OPENAI_MAX_RETRIES === undefined ? undefined : Number(env.OPENAI_MAX_RETRIES),
    maxOutputTokens:
      env.OPENAI_MAX_OUTPUT_TOKENS === undefined ? undefined : Number(env.OPENAI_MAX_OUTPUT_TOKENS),
    reasoningEffort:
      env.OPENAI_REASONING_EFFORT === undefined
        ? undefined
        : env.OPENAI_REASONING_EFFORT === "null"
          ? null
          : env.OPENAI_REASONING_EFFORT,
  });
}

export interface OpenAIClientFactoryOptions {
  readonly fetch?: typeof fetch;
}

export function createOpenAIClient(
  configInput: OpenAIParserConfig,
  options: OpenAIClientFactoryOptions = {},
): OpenAI {
  const config = parseOpenAIConfig(configInput);

  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    fetch: options.fetch,
  });
}
