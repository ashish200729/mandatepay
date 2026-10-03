import "server-only";

import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
const ALLOWED_PATHS = [
  /^auth\/(?:sign-up\/email|sign-in\/email|sign-out)$/,
  /^auth\/(?:send-verification-email|verify-email|request-password-reset|reset-password)$/,
  /^auth\/reset-password\/[A-Za-z0-9_-]+$/,
  /^me$/,
  /^mandates(?:\/[A-Za-z0-9_-]+)?$/,
  /^mandates\/parse$/,
  /^mandates\/[A-Za-z0-9_-]+\/(?:activate|pause|resume|revoke)$/,
  /^approvals$/,
  /^orders(?:\/[A-Za-z0-9_-]+)?$/,
  /^settings$/,
  /^paypal\/(?:status|orders)$/,
  /^paypal\/orders\/[A-Za-z0-9_-]+\/capture$/,
  /^dashboard\/(?:summary|transactions|policy-events|query)$/,
  /^audit$/,
  /^agent\/(?:chat|recommend)$/,
  /^products\/(?:search|compare)$/,
  /^proposals(?:\/[A-Za-z0-9_-]+)?(?:\/evaluate|\/approve|\/reject)?$/,
  /^payments(?:\/[A-Za-z0-9_-]+)?(?:\/refund)?$/,
] as const;

const FORWARDED_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "origin",
  "referer",
  "user-agent",
  "x-csrf-token",
  "x-request-id",
] as const;

const RESPONSE_HEADERS = ["cache-control", "content-type", "etag", "location", "vary"] as const;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

function isAllowedPath(pathname: string) {
  return ALLOWED_PATHS.some((pattern) => pattern.test(pathname));
}

function getPath(params: { path?: string[] }) {
  if (
    !params.path?.length ||
    params.path.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const pathname = params.path.join("/");
  return isAllowedPath(pathname) ? pathname : null;
}

export function isAllowedContentType(value: string | null) {
  if (!value) return true;
  return ALLOWED_CONTENT_TYPES.has(value.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

export function buildForwardHeaders(request: Request) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(upstream: Response, response: NextResponse) {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) response.headers.set(name, value);
  }

  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies = getSetCookie?.call(upstream.headers) ?? [];

  if (cookies.length) {
    for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  } else {
    const cookie = upstream.headers.get("set-cookie");
    if (cookie) response.headers.set("set-cookie", cookie);
  }
}

export async function proxyToApi(request: Request, params: { path?: string[] }) {
  const pathname = getPath(params);
  if (!pathname) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !isAllowedContentType(request.headers.get("content-type"))
  ) {
    return NextResponse.json({ error: "Unsupported content type" }, { status: 415 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`/api/${pathname}`, API_URL);
  target.search = incoming.search;

  const headers = buildForwardHeaders(request);

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream: Response;
  const shoppingChat = pathname === "agent/chat";
  // Chat has a 120-second server deadline covering multiple AI/tool rounds.
  const timeoutMs = shoppingChat ? 130_000 : pathname === "mandates/parse" ? 60_000 : 10_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, timeoutSignal]),
    });
  } catch {
    if (shoppingChat) {
      return NextResponse.json(
        timeoutSignal.aborted
          ? {
              code: "SHOPPING_TIMEOUT",
              error:
                "The shopping assistant took too long to respond. Retry the same request in a moment.",
            }
          : {
              code: "SHOPPING_SERVICE_UNAVAILABLE",
              error:
                "We couldn’t connect to the shopping assistant. Retry the same request shortly.",
            },
        { status: timeoutSignal.aborted ? 504 : 503 },
      );
    }
    return NextResponse.json(
      { error: "The service is temporarily unavailable. Try again shortly." },
      { status: 503 },
    );
  }

  if (upstream.status >= 500) {
    if (shoppingChat) {
      const payload = (await upstream.json().catch(() => null)) as { code?: unknown } | null;
      const messages: Record<string, string> = {
        SHOPPING_TIMEOUT:
          "The shopping assistant took too long to respond. Retry the same request in a moment.",
        SHOPPING_AI_UNAVAILABLE:
          "The shopping assistant’s AI service is unavailable. Retry the same request shortly.",
        SHOPPING_AI_RESPONSE_INVALID:
          "The shopping assistant couldn’t read the AI service’s response. Retry the same request in a moment.",
        SHOPPING_TOOLS_UNAVAILABLE:
          "Product search or comparison is temporarily unavailable. Retry the same request shortly.",
      };
      const code =
        typeof payload?.code === "string" && Object.hasOwn(messages, payload.code)
          ? payload.code
          : "SHOPPING_SERVICE_UNAVAILABLE";
      return NextResponse.json(
        {
          code,
          error:
            messages[code] ??
            "The shopping assistant is temporarily unavailable. Retry the same request shortly.",
        },
        {
          status: code === "SHOPPING_TIMEOUT" ? 504 : upstream.status === 502 ? 502 : 503,
        },
      );
    }
    return NextResponse.json(
      { error: "The service is temporarily unavailable. Try again shortly." },
      { status: 503 },
    );
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
  });
  copyResponseHeaders(upstream, response);
  return response;
}
