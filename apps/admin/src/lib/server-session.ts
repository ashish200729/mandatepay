import "server-only";
import { cookies } from "next/headers";
import { parseAdminMe, type AdminMe } from "./session";

export type AdminSessionResult =
  { status: "authenticated"; admin: AdminMe } | { status: "expired" | "denied" | "unavailable" };

export async function getAdminSession(): Promise<AdminSessionResult> {
  const header = (await cookies())
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  return readAdminSession(header);
}

export async function readAdminSession(header: string): Promise<AdminSessionResult> {
  if (!header) return { status: "expired" };
  try {
    const response = await fetch(
      new URL("/api/admin/me", process.env.API_URL ?? "http://127.0.0.1:4000"),
      {
        headers: { accept: "application/json", cookie: header },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (response.status === 401) return { status: "expired" };
    if (response.status === 403) return { status: "denied" };
    if (!response.ok) return { status: "unavailable" };
    const admin = parseAdminMe(await response.json());
    return admin ? { status: "authenticated", admin } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
