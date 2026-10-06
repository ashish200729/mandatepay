import { AdminActionError } from "./action-error";

export async function postAdminControl(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<{ status: "success" | "pending"; changed: boolean }> {
  const response = await fetch(`/api/admin/${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await response.json().catch(() => null)) as {
    error?: { code?: string };
    pending?: boolean;
    changed?: boolean;
  } | null;
  const code = json?.error?.code;
  if (response.status === 401) {
    window.location.replace("/login?state=expired");
    throw new AdminActionError("unavailable");
  }
  if (response.status === 403 && code === "ADMIN_REAUTH_REQUIRED")
    throw new AdminActionError("fresh-auth");
  if (response.status === 403) {
    window.location.replace("/access-denied");
    throw new AdminActionError("unavailable");
  }
  if (
    response.status === 409 &&
    (code === "CONFLICT" ||
      code === "INVALID_STATE" ||
      code === "ADMIN_RETRY_NOT_ALLOWED" ||
      code === "ADMIN_ACTION_NOT_ALLOWED")
  )
    throw new AdminActionError("conflict");
  if (response.status === 400) throw new AdminActionError("invalid");
  if (!response.ok) throw new AdminActionError("unavailable");
  return {
    status: json?.pending ? "pending" : "success",
    changed: json?.changed === true,
  };
}
