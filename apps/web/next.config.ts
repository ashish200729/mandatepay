import type { NextConfig } from "next";
import { resolve } from "node:path";
import {
  loadWorkspaceEnvironment,
  repositoryRoot,
  WEB_ENV_KEYS,
} from "../../scripts/environment.mjs";
import { securityHeaders } from "./security-headers.mjs";

// Next.js has already loaded workspace files; add only safe root defaults.
loadWorkspaceEnvironment({
  workspaceDirectory: resolve(repositoryRoot, "apps/web"),
  keys: WEB_ENV_KEYS,
});

const nextConfig: NextConfig = {
  transpilePackages: ["@mandatepay/ui"],
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

export default nextConfig;
