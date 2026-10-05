import "server-only";
import { NextResponse } from "next/server";
import { parseAdminMe } from "./session";

const METHODS: Record<string, readonly string[]> = {
  session: ["POST"],
  me: ["GET", "HEAD"],
  reauth: ["POST"],
  "sign-out": ["POST"],
};
const MAX_BODY = 4096;
const MESSAGES: Record<string, string> = {
  ADMIN_UNAUTHORIZED: "Your admin session expired. Sign in again.",
  ADMIN_FORBIDDEN: "This account cannot access administration.",
  ADMIN_REAUTH_REQUIRED: "Confirm your password before this action.",
  ADMIN_SIGN_IN_REJECTED: "Unable to sign in with this account. Check your credentials and access.",
  ADMIN_INVALID_REQUEST: "Check your request and try again.",
  ADMIN_RATE_LIMITED: "Too many requests. Try again shortly.",
  ADMIN_UNAVAILABLE: "Administration is temporarily unavailable. Try again shortly.",
};
function failure(code: string, status: number, requestId?: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message: MESSAGES[code] ?? MESSAGES.ADMIN_UNAVAILABLE,
        ...(requestId ? { requestId } : {}),
      },
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

export async function proxyAdmin(request: Request, params: { path?: string[] }) {
  if (params.path?.length !== 1 || !Object.hasOwn(METHODS, params.path[0]!))
    return failure("ADMIN_INVALID_REQUEST", 404);
  const pathname = params.path[0]!;
  if (!METHODS[pathname]!.includes(request.method)) return failure("ADMIN_INVALID_REQUEST", 405);
  const incoming = new URL(request.url);
  if (incoming.search) return failure("ADMIN_INVALID_REQUEST", 400);
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const configured =
      process.env.ADMIN_ORIGIN ??
      (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3001");
    if (!configured) return failure("ADMIN_UNAVAILABLE", 503);
    const allowed = [new URL(configured).origin];
    if (process.env.NODE_ENV !== "production") {
      const alias = new URL(configured);
      if (["localhost", "127.0.0.1"].includes(alias.hostname)) {
        alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
        allowed.push(alias.origin);
      }
    }
    // Next may reconstruct an internal HTTP URL behind a TLS proxy. The exact
    // configured Origin remains authority; Host must identify that same origin.
    if (
      !origin ||
      !allowed.includes(origin) ||
      (request.headers.get("host") ?? incoming.host) !== new URL(origin).host
    )
      return failure("ADMIN_FORBIDDEN", 403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return failure("ADMIN_INVALID_REQUEST", 400);
  }
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "origin", "content-type", "user-agent"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let body: Uint8Array | undefined;
  if (request.method === "POST" && request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        return failure("ADMIN_INVALID_REQUEST", 413);
      }
      chunks.push(item.value);
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
  }
  try {
    const response = await fetch(
      new URL(`/api/admin/${pathname}`, process.env.API_URL ?? "http://127.0.0.1:4000"),
      {
        method: request.method,
        headers,
        body: body as BodyInit | undefined,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (request.method === "HEAD") {
      return new NextResponse(null, {
        status: [200, 401, 403, 429, 503].includes(response.status) ? response.status : 503,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (response.status === 204 && pathname === "sign-out") {
      const result = new NextResponse(null, {
        status: 204,
        headers: { "cache-control": "private, no-store" },
      });
      for (const cookie of response.headers.getSetCookie())
        result.headers.append("set-cookie", cookie);
      return result;
    }
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string; requestId?: string };
      requestId?: string;
    } | null;
    if (!response.ok) {
      const fallback: Record<number, string> = {
        400: "ADMIN_INVALID_REQUEST",
        401: "ADMIN_UNAUTHORIZED",
        403: "ADMIN_FORBIDDEN",
        429: "ADMIN_RATE_LIMITED",
      };
      const code =
        json?.error?.code && Object.hasOwn(MESSAGES, json.error.code)
          ? json.error.code
          : (fallback[response.status] ?? "ADMIN_UNAVAILABLE");
      const result = failure(
        code,
        [400, 401, 403, 429, 503].includes(response.status) ? response.status : 503,
        json?.error?.requestId,
      );
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter && /^\d{1,5}$/u.test(retryAfter))
        result.headers.set("retry-after", retryAfter);
      return result;
    }
    const admin = parseAdminMe(json);
    if (!admin) return failure("ADMIN_UNAVAILABLE", 503);
    const result = NextResponse.json(
      { data: admin, requestId: json?.requestId },
      { headers: { "cache-control": "private, no-store" } },
    );
    if (pathname === "session" || pathname === "reauth") {
      for (const cookie of response.headers.getSetCookie())
        result.headers.append("set-cookie", cookie);
    }
    return result;
  } catch {
    return failure("ADMIN_UNAVAILABLE", 503);
  }
}
