import "server-only";
import { NextResponse } from "next/server";
import { AdminTraceIdSchema, ADMIN_EXPORT_COLUMNS, parseAdminCsv } from "@mandatepay/shared";
import { matchAdminProxy } from "./admin-routes";

const MAX_BODY = 4096;
const MAX_CSV = 2_000_000;
const MESSAGES: Record<string, string> = {
  ADMIN_UNAUTHORIZED: "Your admin session expired. Sign in again.",
  ADMIN_FORBIDDEN: "This account cannot access administration.",
  ADMIN_REAUTH_REQUIRED: "Confirm your password before this action.",
  ADMIN_SIGN_IN_REJECTED: "Unable to sign in with this account. Check your credentials and access.",
  ADMIN_INVALID_REQUEST: "Check your request and try again.",
  ADMIN_RATE_LIMITED: "Too many requests. Try again shortly.",
  ADMIN_UNAVAILABLE: "Administration is temporarily unavailable. Try again shortly.",
  ADMIN_TARGET_NOT_FOUND: "The requested record was not found.",
  CONFLICT: "The record changed. Reload its current state before trying again.",
  INVALID_STATE: "The record is not in a valid state for this action.",
  ADMIN_RETRY_NOT_ALLOWED:
    "Retry is limited to verified due failures or stale processing leases under the five-attempt cap.",
  ADMIN_RECONCILE_FAILED:
    "Provider confirmation is pending. Check the current state before retrying.",
  ADMIN_ACTION_NOT_ALLOWED: "This action is not allowed in the current state.",
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
function withTrace(result: NextResponse, upstream: Response) {
  for (const name of ["x-request-id", "x-correlation-id"]) {
    const value = upstream.headers.get(name);
    if (AdminTraceIdSchema.safeParse(value).success) result.headers.set(name, value!);
  }
  return result;
}

export async function proxyAdmin(request: Request, params: { path?: string[] }) {
  const match = matchAdminProxy(params.path, request.method);
  if (!match) return failure("ADMIN_INVALID_REQUEST", 404);
  if (!match.methods.includes(request.method)) return failure("ADMIN_INVALID_REQUEST", 405);
  const incoming = new URL(request.url);
  if (incoming.search && !match.allowSearch) return failure("ADMIN_INVALID_REQUEST", 400);
  if (match.allowSearch) {
    if (
      Array.from(incoming.searchParams.keys()).some(
        (key) => incoming.searchParams.getAll(key).length !== 1,
      ) ||
      (match.query && !match.query.safeParse(Object.fromEntries(incoming.searchParams)).success)
    )
      return failure("ADMIN_INVALID_REQUEST", 400);
  }
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
    if (
      !origin ||
      !allowed.includes(origin) ||
      (request.headers.get("host") ?? incoming.host) !== new URL(origin).host
    )
      return failure("ADMIN_FORBIDDEN", 403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return failure("ADMIN_INVALID_REQUEST", 400);
  }
  const headers = new Headers({ accept: match.kind === "csv" ? "text/csv" : "application/json" });
  const correlation = request.headers.get("x-correlation-id");
  if (correlation !== null && !AdminTraceIdSchema.safeParse(correlation).success)
    return failure("ADMIN_INVALID_REQUEST", 400);
  headers.set("x-correlation-id", correlation ?? crypto.randomUUID());
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
      new URL(
        `/api/admin/${match.upstreamPath}${incoming.search}`,
        process.env.API_URL ?? "http://127.0.0.1:4000",
      ),
      {
        method: request.method,
        headers,
        body: body as BodyInit | undefined,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(
            match.kind === "csv" ? 30_000 : request.method === "POST" ? 30_000 : 15_000,
          ),
        ]),
      },
    );
    if (request.method === "HEAD") {
      return withTrace(
        new NextResponse(null, {
          status: [200, 401, 403, 404, 409, 429, 503].includes(response.status)
            ? response.status
            : 503,
          headers: { "cache-control": "private, no-store" },
        }),
        response,
      );
    }
    if (response.status === 204 && match.upstreamPath === "sign-out") {
      const result = new NextResponse(null, {
        status: 204,
        headers: { "cache-control": "private, no-store" },
      });
      for (const cookie of response.headers.getSetCookie())
        result.headers.append("set-cookie", cookie);
      return withTrace(result, response);
    }
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as {
        error?: { code?: string; requestId?: string };
      } | null;
      const fallback: Record<number, string> = {
        400: "ADMIN_INVALID_REQUEST",
        401: "ADMIN_UNAUTHORIZED",
        403: "ADMIN_FORBIDDEN",
        409: "CONFLICT",
        429: "ADMIN_RATE_LIMITED",
      };
      const code =
        json?.error?.code && Object.hasOwn(MESSAGES, json.error.code)
          ? json.error.code
          : (fallback[response.status] ?? "ADMIN_UNAVAILABLE");
      const result = failure(
        code,
        [400, 401, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 503,
        AdminTraceIdSchema.safeParse(json?.error?.requestId).success
          ? json?.error?.requestId
          : undefined,
      );
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter && /^\d{1,5}$/u.test(retryAfter))
        result.headers.set("retry-after", retryAfter);
      return withTrace(result, response);
    }
    if (match.kind === "csv") {
      const text = await response.text();
      if (
        text.length > MAX_CSV ||
        !match.csvResource ||
        !parseAdminCsv(text, ADMIN_EXPORT_COLUMNS[match.csvResource])
      )
        return failure("ADMIN_UNAVAILABLE", 503);
      const result = new NextResponse(text, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${match.csvResource}.csv"`,
        },
      });
      for (const name of ["x-export-truncated", "x-export-row-count"] as const) {
        const value = response.headers.get(name);
        if (value) result.headers.set(name, value);
      }
      return withTrace(result, response);
    }
    const json = (await response.json().catch(() => null)) as {
      requestId?: string;
    } | null;
    const parsed = match.parseJson ? match.parseJson(json) : null;
    if (!parsed || typeof parsed !== "object") return failure("ADMIN_UNAVAILABLE", 503);
    const result = NextResponse.json(
      {
        ...parsed,
        requestId: AdminTraceIdSchema.safeParse(json?.requestId).success
          ? json?.requestId
          : undefined,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
    if (match.upstreamPath === "session" || match.upstreamPath === "reauth") {
      for (const cookie of response.headers.getSetCookie())
        result.headers.append("set-cookie", cookie);
    }
    return withTrace(result, response);
  } catch {
    return failure("ADMIN_UNAVAILABLE", 503);
  }
}
