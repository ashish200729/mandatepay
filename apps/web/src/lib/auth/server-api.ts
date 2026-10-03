import "server-only";

import { cookies } from "next/headers";

export type Principal = {
  id: string;
  name: string;
  email: string;
  autonomousPurchasingEnabled: boolean;
};

export type ClientPrincipal = Omit<Principal, "id">;

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

export class SessionServiceUnavailableError extends Error {
  constructor() {
    super("The session service is temporarily unavailable.");
    this.name = "SessionServiceUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizePrincipal(value: unknown): Principal | null {
  const user = isRecord(value) && isRecord(value.user) ? value.user : value;

  if (
    !isRecord(user) ||
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.email !== "string" ||
    typeof user.autonomousPurchasingEnabled !== "boolean"
  ) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    autonomousPurchasingEnabled: user.autonomousPurchasingEnabled,
  };
}

export function toClientPrincipal(principal: Principal): ClientPrincipal {
  return {
    name: principal.name,
    email: principal.email,
    autonomousPurchasingEnabled: principal.autonomousPurchasingEnabled,
  };
}

export async function getServerSession(): Promise<Principal | null> {
  const cookieHeader = (await cookies())
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  if (!cookieHeader) return null;

  try {
    const response = await fetch(`${API_URL}/api/me`, {
      headers: {
        accept: "application/json",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });

    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new SessionServiceUnavailableError();

    const principal = sanitizePrincipal(await response.json().catch(() => null));
    if (!principal) throw new SessionServiceUnavailableError();
    return principal;
  } catch {
    throw new SessionServiceUnavailableError();
  }
}
