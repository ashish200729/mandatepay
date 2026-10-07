import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function adminApi(path: string) {
  const header = (await cookies())
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  if (!header) redirect("/login?state=expired");
  let response: Response;
  try {
    response = await fetch(new URL(path, process.env.API_URL ?? "http://127.0.0.1:4000"), {
      headers: { accept: "application/json", cookie: header },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: 503, json: null };
  }
  // Next redirects throw; keep them outside the upstream failure handler.
  if (response.status === 401) redirect("/login?state=expired");
  if (response.status === 403) redirect("/access-denied");
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}
