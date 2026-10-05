export type AdminMe = {
  user: { id: string; name: string | null; email: string; emailVerified: boolean };
  principal: { id: string; role: "ADMIN_SUPER" };
  session: { expiresAt: string; idleExpiresAt: string; freshAuthUntil: string };
  capabilities: string[];
};

/** Construct a whitelist projection even when the upstream JSON contains extra fields. */
export function parseAdminMe(value: unknown): AdminMe | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: Partial<AdminMe> }).data;
  if (!data?.user || !data.principal || !data.session || !Array.isArray(data.capabilities))
    return null;
  const { user, principal, session } = data;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    (user.name !== null && typeof user.name !== "string") ||
    user.emailVerified !== true ||
    typeof principal.id !== "string" ||
    principal.role !== "ADMIN_SUPER" ||
    !data.capabilities.every((v) => typeof v === "string")
  )
    return null;
  if (
    ![session.expiresAt, session.idleExpiresAt, session.freshAuthUntil].every(
      (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
    )
  )
    return null;
  return {
    user: { id: user.id, name: user.name, email: user.email, emailVerified: true },
    principal: { id: principal.id, role: principal.role },
    session: {
      expiresAt: session.expiresAt,
      idleExpiresAt: session.idleExpiresAt,
      freshAuthUntil: session.freshAuthUntil,
    },
    capabilities: [...data.capabilities],
  };
}
