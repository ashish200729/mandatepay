/** Per-process protection; deploy one API replica or add a shared limiter before scaling. */
export function createMutationRateLimiter({
  maximum = 30,
  windowMs = 60_000,
  capacity = 2_048,
} = {}) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return (userId: string, now = Date.now()): { allowed: boolean; retryAfter: number } => {
    for (const [key, entry] of entries) if (entry.resetAt <= now) entries.delete(key);
    const current = entries.get(userId);
    if (!current) {
      if (entries.size >= capacity)
        return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
      entries.set(userId, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (current.count >= maximum) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count += 1;
    return { allowed: true, retryAfter: 0 };
  };
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
