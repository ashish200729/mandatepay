import type { NextConfig } from "next";
import { resolve } from "node:path";
import {
  loadWorkspaceEnvironment,
  repositoryRoot,
  ADMIN_ENV_KEYS,
} from "../../scripts/environment.mjs";

loadWorkspaceEnvironment({
  workspaceDirectory: resolve(repositoryRoot, "apps/admin"),
  keys: ADMIN_ENV_KEYS,
});

const config: NextConfig = {
  transpilePackages: ["@mandatepay/ui"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};
export default config;
