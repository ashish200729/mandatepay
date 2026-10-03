import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadE2eEnvironment } from "./e2e-environment.mjs";
import { startE2eParserProvider } from "./e2e-parser-provider.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = {
  ...process.env,
  ...loadE2eEnvironment(),
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "4100",
  WEB_ORIGIN: "http://127.0.0.1:3100",
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  LOG_LEVEL: "warn",
  OPENAI_API_KEY: "e2e-only-provider-key",
  OPENAI_MODEL: "mandate-e2e-fixture",
  OPENAI_BASE_URL: "http://127.0.0.1:4200/v1",
  OPENAI_RESPONSE_MODE: "json_schema",
  CHANNEL3_API_KEY: "",
  PRODUCT_DISCOVERY_MODE: "demo",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_WEBHOOK_ID: "",
  PAYPAL_ENV: "sandbox",
};
environment.DATABASE_URL = environment.TEST_DATABASE_URL;

function run(args, env = environment) {
  const result = spawnSync("pnpm", args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error("E2E prerequisite failed; services were not started.");
}

run(["--filter", "@mandatepay/database", "migrate:deploy"]);
run(["--filter", "@mandatepay/api...", "build"]);
run(["--filter", "@mandatepay/web", "build"], { ...environment, NODE_ENV: "production" });

const parserProvider = await startE2eParserProvider();
const processes = [
  spawn("node", ["scripts/e2e-api-server.mjs"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
    detached: false,
  }),
  spawn(
    "pnpm",
    [
      "--filter",
      "@mandatepay/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    {
      cwd: root,
      env: { ...environment, NODE_ENV: "production" },
      stdio: "inherit",
      detached: false,
    },
  ),
];

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  parserProvider.close();
  for (const child of processes) {
    if (!child.pid) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      /* A service already exited. */
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}
for (const child of processes) {
  child.on("error", () => shutdown(1));
  child.on("exit", (code) => {
    if (!stopping) shutdown(code || 1);
  });
}
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
