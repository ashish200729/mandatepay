import type { NextConfig } from "next";
import { resolve } from "node:path";
import {
  loadWorkspaceEnvironment,
  repositoryRoot,
  WEB_ENV_KEYS,
} from "../../scripts/environment.mjs";

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
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
