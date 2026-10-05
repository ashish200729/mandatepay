import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAdminBoundaries } from "./check-admin-boundaries.mjs";
test("admin boundary gate rejects server dependencies and direct/dynamic backend imports", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "admin-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { "@mandatepay/ui": "workspace:*" } }),
  );
  writeFileSync(
    join(directory, "src", "page.tsx"),
    'import { Button } from "@mandatepay/ui/components/button";',
  );
  assert.doesNotThrow(() => checkAdminBoundaries(directory));
  for (const code of [
    'import { db } from "@mandatepay/database";',
    'const payment = await import("@mandatepay/paypal");',
    'const db = require("@prisma/client");',
  ]) {
    writeFileSync(join(directory, "src", "page.tsx"), code);
    assert.throws(() => checkAdminBoundaries(directory), /server boundary/u);
  }
  writeFileSync(join(directory, "src", "page.tsx"), "export const safe = true;");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { "better-auth": "1.7.7" } }),
  );
  assert.throws(() => checkAdminBoundaries(directory), /server boundary/u);
});
