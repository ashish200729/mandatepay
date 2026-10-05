import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "next-env.d.ts"]),
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@mandatepay/database",
            "@mandatepay/database/*",
            "@mandatepay/paypal",
            "@mandatepay/paypal/*",
            "@mandatepay/agentguard",
            "@mandatepay/agentguard/*",
            "@mandatepay/agent",
            "@mandatepay/agent/*",
            "@prisma/*",
            "better-auth",
            "better-auth/*",
          ],
        },
      ],
    },
  },
]);
