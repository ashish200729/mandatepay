// Response headers for every admin route. Kept beside next.config.ts so Turbo hashes changes.
// App Router injects inline bootstrap scripts; without per-request nonces, script-src keeps
// 'unsafe-inline'. 'unsafe-eval' and HMR websockets are allowed only by the development server.
// The console never submits forms to third parties, so form-action stays same-origin.

/** @param {"development" | "production" | "test" | string | undefined} mode */
export function contentSecurityPolicy(mode) {
  const development = mode === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** @param {"development" | "production" | "test" | string | undefined} mode */
export function securityHeaders(mode) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(mode) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Cache-Control", value: "private, no-store" },
    ...(mode === "production"
      ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
      : []),
  ];
}
