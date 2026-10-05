import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden =
  /(?:@mandatepay\/(?:database|paypal|agentguard|agent|channel3)|@prisma\/|better-auth)/u;
export function checkAdminBoundaries(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (forbidden.test(name))
      throw new Error("Admin dependency crosses a server boundary: " + name);
  }
  function inspect(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) inspect(path);
      else if (/\.[cm]?[jt]sx?$/u.test(item.name) && !item.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8");
        if (forbidden.test(source))
          throw new Error("Admin source crosses a server boundary: " + path);
      }
    }
  }
  inspect(join(directory, "src"));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkAdminBoundaries(fileURLToPath(new URL("../apps/admin", import.meta.url)));
  console.info("Admin server-package boundaries passed.");
}
