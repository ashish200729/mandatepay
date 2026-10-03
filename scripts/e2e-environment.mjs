import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadE2eEnvironment() {
  let local = {};
  try {
    local = parseEnv(
      readFileSync(fileURLToPath(new URL("../packages/database/.env", import.meta.url)), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const testDatabaseUrl = process.env.TEST_DATABASE_URL || local.TEST_DATABASE_URL;
  if (!testDatabaseUrl)
    throw new Error(
      "E2E requires a dedicated TEST_DATABASE_URL. Run pnpm db:local:start or configure the CI test database.",
    );
  const database = new URL(testDatabaseUrl);
  if (
    !["postgresql:", "postgres:"].includes(database.protocol) ||
    !database.pathname.endsWith("_test")
  ) {
    throw new Error(
      "E2E database name must end in _test; never use a development or production database.",
    );
  }
  return {
    TEST_DATABASE_URL: testDatabaseUrl,
    MANDATEPAY_E2E_AUTH: "1",
    MANDATEPAY_E2E_MANDATES: "1",
    MANDATEPAY_E2E_MOCK_PARSER: "1",
    MANDATEPAY_E2E_API_URL: "http://127.0.0.1:4100",
    API_URL: "http://127.0.0.1:4100",
    APP_URL: "http://127.0.0.1:3100",
  };
}
