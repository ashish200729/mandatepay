export type AdminEnvironment = "local" | "test" | "staging" | "production" | "unknown";
/** Never assume that a production Next build means a production deployment. */
export function adminEnvironment(
  value: string | undefined,
  origin: string | undefined,
): AdminEnvironment {
  if (value !== undefined && value !== "")
    return ["local", "test", "staging", "production"].includes(value)
      ? (value as AdminEnvironment)
      : "unknown";
  try {
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(origin ?? "http://localhost:3001").hostname,
      )
    )
      return "local";
  } catch {
    return "unknown";
  }
  return "unknown";
}
