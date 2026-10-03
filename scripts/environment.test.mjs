import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  API_ENV_KEYS,
  DATABASE_ENV_KEYS,
  WEB_ENV_KEYS,
  loadWorkspaceEnvironment,
  readWorkspaceEnvironment,
} from "./environment.mjs";

function fixture(t) {
  const rootDirectory = mkdtempSync(join(tmpdir(), "mandatepay-env-"));
  const workspaceDirectory = join(rootDirectory, "apps/api");
  mkdirSync(workspaceDirectory, { recursive: true });
  t.after(() => rmSync(rootDirectory, { recursive: true, force: true }));
  return {
    rootDirectory,
    workspaceDirectory,
    environment: {},
    root(name, content) {
      writeFileSync(join(rootDirectory, name), content);
    },
    workspace(name, content) {
      writeFileSync(join(workspaceDirectory, name), content);
    },
  };
}

test("missing files preserve injected values, including explicit empty strings", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    {
      ...readWorkspaceEnvironment({ ...f, environment: { API_URL: "", AUTH_SECRET: "injected" } }),
    },
    { API_URL: "", AUTH_SECRET: "injected" },
  );
});

test("root defaults, local/mode files, workspace overrides and injected values have defined precedence", (t) => {
  const f = fixture(t);
  f.root(".env", "ROOT_ONLY=base\nAPI_URL=root\nGLOBAL_ONLY=base");
  f.root(".env.local", "GLOBAL_ONLY=local");
  f.root(".env.production", "GLOBAL_ONLY=production");
  f.root(".env.production.local", "GLOBAL_ONLY=production-local\nAPI_URL=root-production");
  f.workspace(".env", "API_URL=workspace\nWORKSPACE_ONLY=base");
  f.workspace(".env.local", "WORKSPACE_ONLY=local");
  f.workspace(".env.production", "WORKSPACE_ONLY=production");
  f.workspace(".env.production.local", "WORKSPACE_ONLY=production-local");
  const result = readWorkspaceEnvironment({
    ...f,
    mode: "production",
    environment: { ROOT_ONLY: "shell" },
  });
  assert.deepEqual(
    { ...result },
    {
      ROOT_ONLY: "shell",
      API_URL: "workspace",
      GLOBAL_ONLY: "production-local",
      WORKSPACE_ONLY: "production-local",
    },
  );
});

test("an empty workspace value clears a global credential", (t) => {
  const f = fixture(t);
  f.root(".env", "OPENAI_API_KEY=fixture-only");
  f.workspace(".env", "OPENAI_API_KEY=");
  assert.equal(readWorkspaceEnvironment(f).OPENAI_API_KEY, "");
});

test("test mode skips generic local files and keeps test-specific overrides", (t) => {
  const f = fixture(t);
  f.root(".env", "TEST_DATABASE_URL=root-test");
  f.root(".env.local", "TEST_DATABASE_URL=wrong-local");
  f.workspace(".env.local", "TEST_DATABASE_URL=wrong-workspace-local");
  f.workspace(".env.test", "TEST_DATABASE_URL=isolated-test");
  f.workspace(".env.test.local", "TEST_DATABASE_URL=isolated-test-local");
  assert.equal(
    readWorkspaceEnvironment({ ...f, mode: "test" }).TEST_DATABASE_URL,
    "isolated-test-local",
  );
});

test("web imports only server URLs, excluding provider/auth/database secrets and public aliases", (t) => {
  const f = fixture(t);
  f.root(
    ".env",
    "API_URL=http://root.test\nAPP_URL=http://web.test\nOPENAI_API_KEY=private\nPAYPAL_CLIENT_SECRET=private\nDATABASE_URL=private\nAUTH_SECRET=private\nNEXT_PUBLIC_SECRET=private",
  );
  assert.deepEqual(
    { ...readWorkspaceEnvironment({ ...f, keys: WEB_ENV_KEYS }) },
    {
      API_URL: "http://root.test",
      APP_URL: "http://web.test",
    },
  );
});

test("database tooling reads only URLs and API reads supported runtime knobs", (t) => {
  const f = fixture(t);
  f.root(
    ".env",
    "DATABASE_URL=development\nTEST_DATABASE_URL=isolated\nOPENAI_MAX_OUTPUT_TOKENS=1024\nCHANNEL3_TIMEOUT_MS=5000\nPAYPAL_CLIENT_SECRET=fixture-only\nNODE_OPTIONS=unsafe",
  );
  assert.deepEqual(
    { ...readWorkspaceEnvironment({ ...f, keys: DATABASE_ENV_KEYS }) },
    {
      DATABASE_URL: "development",
      TEST_DATABASE_URL: "isolated",
    },
  );
  const api = readWorkspaceEnvironment({ ...f, keys: API_ENV_KEYS });
  assert.equal(api.OPENAI_MAX_OUTPUT_TOKENS, "1024");
  assert.equal(api.CHANNEL3_TIMEOUT_MS, "5000");
  assert.equal(api.NODE_OPTIONS, undefined);
});

test("quoted, commented, multiline and literal dollar values use Node dotenv parsing", (t) => {
  const f = fixture(t);
  f.root(
    ".env",
    '# comment\nexport AUTH_SECRET="literal $VALUE # secret"\nAPI_URL=http://api.test # comment\nMULTILINE="first\nsecond"',
  );
  assert.deepEqual(
    { ...readWorkspaceEnvironment(f) },
    {
      AUTH_SECRET: "literal $VALUE # secret",
      API_URL: "http://api.test",
      MULTILINE: "first\nsecond",
    },
  );
});

test("read does not mutate environment; load preserves injected variables", (t) => {
  const f = fixture(t);
  f.root(".env", "API_URL=root\nAPP_URL=web\nOPENAI_API_KEY=private");
  const environment = { API_URL: "injected", OTHER: "keep" };
  readWorkspaceEnvironment({ ...f, environment, keys: WEB_ENV_KEYS });
  assert.deepEqual(environment, { API_URL: "injected", OTHER: "keep" });
  loadWorkspaceEnvironment({ ...f, environment, keys: WEB_ENV_KEYS });
  assert.deepEqual(environment, { API_URL: "injected", APP_URL: "web", OTHER: "keep" });
});

test("unreadable files fail closed without including file contents", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.rootDirectory, ".env"));
  assert.throws(() => readWorkspaceEnvironment(f), /Unable to read environment file:/);
});

test("invalid mode is rejected instead of forming arbitrary paths", (t) => {
  assert.throws(
    () => readWorkspaceEnvironment({ ...fixture(t), mode: "../../private" }),
    /Environment mode/,
  );
});

test("native API startup preload loads overrides before application imports", (t) => {
  const f = fixture(t);
  f.workspace(".env", "PORT=4567\nOPENAI_MAX_OUTPUT_TOKENS=1024\nNODE_OPTIONS=unsafe");
  const preload = fileURLToPath(new URL("./register-api-environment.mjs", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      preload,
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({port: process.env.PORT, tokens: process.env.OPENAI_MAX_OUTPUT_TOKENS, options: process.env.NODE_OPTIONS}))",
    ],
    { cwd: f.workspaceDirectory, env: { NODE_ENV: "development" }, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), { port: "4567", tokens: "1024" });
});
