export interface FixedWindowRateLimitOptions {
  maximum: number;
  windowMs: number;
  capacity: number;
}

/**
 * Per-process fixed-window limiter keyed by an opaque string. New keys are refused once the
 * bounded table is full so memory cannot grow without limit. Deploy one API replica or add a
 * shared limiter before scaling.
 */
export function createFixedWindowRateLimiter({
  maximum,
  windowMs,
  capacity,
}: FixedWindowRateLimitOptions) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now = Date.now()): { allowed: boolean; retryAfter: number } => {
    for (const [entryKey, entry] of entries) if (entry.resetAt <= now) entries.delete(entryKey);
    const current = entries.get(key);
    if (!current) {
      if (entries.size >= capacity)
        return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (current.count >= maximum) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count += 1;
    return { allowed: true, retryAfter: 0 };
  };
}

/** Per-user financial mutation bucket. */
export function createMutationRateLimiter({
  maximum = 30,
  windowMs = 60_000,
  capacity = 2_048,
} = {}) {
  return createFixedWindowRateLimiter({ maximum, windowMs, capacity });
}

const credentialEmailPaths = /\/(?:sign-in|sign-up)\/email$/u;

/**
 * Returns the normalized email for credential sign-in/sign-up requests so attempts against one
 * account share a bucket regardless of the caller's network address.
 */
export function credentialAttemptEmail(method: string, url: string, body: unknown): string | null {
  if (method !== "POST" || !credentialEmailPaths.test(url.split("?")[0] ?? "")) return null;
  let value = body;
  if (typeof value === "string" && value.length <= 65_536) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const email = (value as { email?: unknown }).email;
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized && normalized.length <= 320 ? normalized : null;
}

export function isFinancialMutation(method: string, url: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/(?:proposals(?:\/|$)|paypal\/orders(?:\/|$)|payments\/[^/]+\/(?:refund|refund-status)(?:\?|$))/u.test(
      url,
    )
  );
}

export function safeRequestPath(url: string): string {
  return url.split("?")[0]!.replace(/(\/api\/auth\/reset-password\/)[^/]+/u, "$1[REDACTED]");
}
