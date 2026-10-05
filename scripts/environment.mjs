import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATABASE_ENV_KEYS = ["DATABASE_URL", "TEST_DATABASE_URL"];
export const WEB_ENV_KEYS = ["API_URL", "APP_URL"];
export const ADMIN_ENV_KEYS = ["API_URL", "APP_URL", "ADMIN_ORIGIN"];
export const API_ENV_KEYS = [
  "HOST",
  "PORT",
  "WEB_ORIGIN",
  "ADMIN_ORIGIN",
  "LOG_LEVEL",
  "NODE_ENV",
  "APP_URL",
  "API_URL",
  ...DATABASE_ENV_KEYS,
  "AUTH_SECRET",
  "AUTH_REQUIRE_EMAIL_VERIFICATION",
  "RESEND_API_KEY",
  "AUTH_EMAIL_FROM",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_RESPONSE_MODE",
  "OPENAI_TIMEOUT_MS",
  "OPENAI_MAX_RETRIES",
  "OPENAI_MAX_OUTPUT_TOKENS",
  "OPENAI_REASONING_EFFORT",
  "CHANNEL3_API_KEY",
  "CHANNEL3_BASE_URL",
  "CHANNEL3_TIMEOUT_MS",
  "CHANNEL3_MAX_RETRIES",
  "CHANNEL3_FALLBACK_MODE",
  "PRODUCT_DISCOVERY_MODE",
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "TOKEN_ENCRYPTION_KEY",
];

/** Read defaults first, then workspace overrides. Never overwrite injected values. */
export function readWorkspaceEnvironment({
  workspaceDirectory = process.cwd(),
  rootDirectory = repositoryRoot,
  environment = process.env,
  mode = environment.NODE_ENV ?? "development",
  keys,
} = {}) {
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("Environment mode must be development, test, or production.");
  }
  const names = [
    ".env",
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}`,
    `.env.${mode}.local`,
  ];
  const values = Object.create(null);
  const directories = [...new Set([resolve(rootDirectory), resolve(workspaceDirectory)])];
  const allowed = keys === undefined ? undefined : new Set(keys);
  for (const directory of directories) {
    for (const name of names) {
      let parsed;
      try {
        parsed = parseEnv(readFileSync(resolve(directory, name), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        // Report only the filename; file contents may contain credentials.
        throw new Error(`Unable to read environment file: ${resolve(directory, name)}`);
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (allowed === undefined || allowed.has(key)) values[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && (allowed === undefined || allowed.has(key))) values[key] = value;
  }
  return values;
}

export function loadWorkspaceEnvironment(options = {}) {
  const environment = options.environment ?? process.env;
  const values = readWorkspaceEnvironment({ ...options, environment });
  for (const [key, value] of Object.entries(values)) environment[key] = value;
  return values;
}
