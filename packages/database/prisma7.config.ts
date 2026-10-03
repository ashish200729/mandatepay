import { defineConfig, env } from "prisma/config";
import { fileURLToPath } from "node:url";
import { DATABASE_ENV_KEYS, loadWorkspaceEnvironment } from "../../scripts/environment.mjs";

loadWorkspaceEnvironment({
  workspaceDirectory: fileURLToPath(new URL("./", import.meta.url)),
  keys: DATABASE_ENV_KEYS,
});

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
