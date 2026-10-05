import "server-only";
import { notFound } from "next/navigation";
/** Test host only. Never enabled by HTTP headers, query strings or browser storage. */
export function requireUiFixtures() {
  if (process.env.ADMIN_UI_FIXTURES !== "1" || process.env.ADMIN_ENVIRONMENT !== "test") notFound();
  try {
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(process.env.ADMIN_ORIGIN ?? "").hostname,
      )
    )
      notFound();
  } catch {
    notFound();
  }
}
