import type { AuthNodeEnvironment } from "./auth.js";

export function originsFor(origin: string | undefined, nodeEnv: AuthNodeEnvironment): string[] {
  if (!origin) return [];
  const url = new URL(origin);
  const origins = [url.origin];
  if (nodeEnv !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.push(url.origin);
  }
  return origins;
}

export function trustedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return typeof origin === "string" && allowed.includes(origin);
}
