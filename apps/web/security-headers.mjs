// Response headers for every web route. Kept beside next.config.ts so Turbo hashes changes.
// App Router injects inline bootstrap scripts; without per-request nonces, script-src keeps
// 'unsafe-inline'. 'unsafe-eval' and HMR websockets are allowed only by the development server.

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
    // PayPal approval is a top-level navigation; this also covers redirects after form posts.
    "form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com",
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
    ...(mode === "production"
      ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
      : []),
  ];
}
