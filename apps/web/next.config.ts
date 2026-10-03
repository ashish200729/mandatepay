import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mandatepay/ui"],
  poweredByHeader: false,
};

export default nextConfig;
