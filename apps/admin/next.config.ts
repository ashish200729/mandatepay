import type { NextConfig } from "next";
import { resolve } from "node:path";
import {
  loadWorkspaceEnvironment,
  repositoryRoot,
  ADMIN_ENV_KEYS,
} from "../../scripts/environment.mjs";
import { securityHeaders } from "./security-headers.mjs";

loadWorkspaceEnvironment({
  workspaceDirectory: resolve(repositoryRoot, "apps/admin"),
  keys: ADMIN_ENV_KEYS,
});

const config: NextConfig = {
  transpilePackages: ["@mandatepay/ui", "@mandatepay/shared"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NODE_ENV),
      },
    ];
  },
};
export default config;
