import "server-only";

import { isIP } from "node:net";
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
  /^mandates\/[A-Za-z0-9_-]+\/simulate$/,
  // Signed AP2-shaped mandate credentials: owned reads plus the public JWKS and verifier.
  /^(?:mandates|proposals)\/[A-Za-z0-9_-]+\/credentials$/,
  /^credentials\/(?:jwks|verify)$/,
  /^approvals$/,
  /^orders(?:\/[A-Za-z0-9_-]+)?$/,
  /^settings$/,
  /^paypal\/(?:status|orders)$/,
  /^paypal\/orders\/[A-Za-z0-9_-]+\/(?:capture|reconcile)$/,
  /^dashboard\/(?:summary|transactions|policy-events|query)$/,
  /^audit$/,
  /^agent\/(?:chat|chat\/stream|recommend)$/,
  /^products\/(?:search|compare)$/,
  /^proposals(?:\/[A-Za-z0-9_-]+)?(?:\/evaluate|\/approve|\/reject|\/autopay)?$/,
  /^payment-methods\/paypal(?:\/(?:setup|complete|cancel|remove))?$/,
  // Customer token management only; the agent gateway is called on the API host, never here.
  /^agent-tokens(?:\/[A-Za-z0-9_-]+\/revoke)?$/,
  /^payments(?:\/[A-Za-z0-9_-]+)?(?:\/(?:refund|refund-status))?$/,
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

/**
 * The platform edge (or Next.js itself, from the socket) supplies X-Forwarded-For; its first
 * hop is the browser. Invalid values are dropped so the API falls back to its own peer address.
 */
export function clientIpFrom(request: Request) {
  const candidate = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? "";
  return candidate.length <= 64 && isIP(candidate) ? candidate : null;
}

export function buildForwardHeaders(
  request: Request,
  proxySecret = process.env.INTERNAL_PROXY_SECRET,
) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The API trusts the asserted client address only alongside the shared secret.
  const clientIp = proxySecret ? clientIpFrom(request) : null;
  if (proxySecret && clientIp) {
    headers.set("x-mandatepay-client-ip", clientIp);
    headers.set("x-mandatepay-proxy-secret", proxySecret);
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

const STREAM_TIMEOUT_MESSAGE =
  "The shopping assistant took too long to respond. Retry the same request in a moment.";
const STREAM_UNAVAILABLE_MESSAGE =
  "The connection to the shopping assistant was interrupted. Retry the same request.";

/**
 * Relays the API's Server-Sent Events chunk by chunk, without buffering. If the
 * upstream body fails (the chat deadline, or a dropped API connection), the
 * browser gets one final safe `error` event instead of a silently cut stream.
 * Cancelling the browser side cancels the upstream request, which stops the run.
 */
export function relayEventStream(body: ReadableStream<Uint8Array>, deadline: AbortSignal) {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch {
        const timedOut = deadline.aborted;
        const event = {
          status: timedOut ? 504 : 503,
          code: timedOut ? "SHOPPING_TIMEOUT" : "SHOPPING_STREAM_INTERRUPTED",
          error: timedOut ? STREAM_TIMEOUT_MESSAGE : STREAM_UNAVAILABLE_MESSAGE,
        };
        // A leading blank line closes any partial frame the failure interrupted.
        controller.enqueue(encoder.encode(`\n\nevent: error\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
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
  const shoppingStream = pathname === "agent/chat/stream";
  const shoppingChat = pathname === "agent/chat" || shoppingStream;
  const financialMutation =
    request.method === "POST" &&
    (/^paypal\/orders(?:\/[A-Za-z0-9_-]+\/(?:capture|reconcile))?$/.test(pathname) ||
      /^payments\/[A-Za-z0-9_-]+\/(?:refund|refund-status)$/.test(pathname) ||
      /^proposals\/[A-Za-z0-9_-]+\/autopay$/.test(pathname));
  const refundMutation = financialMutation && /^payments\//.test(pathname);
  const financialFailure = (code: string, status: number) => {
    const operation = refundMutation ? "refund" : "payment";
    const messages: Record<string, string> = {
      PAYPAL_UNAVAILABLE: "PayPal Sandbox is not configured.",
      PAYPAL_OUTCOME_UNKNOWN: `The ${operation} outcome has not been confirmed. Refresh this order to check its status before retrying.`,
      PAYPAL_RESPONSE_INVALID: `The ${operation} confirmation could not be read. Refresh this order to check its status before retrying.`,
    };
    const safeCode = Object.hasOwn(messages, code) ? code : "PAYPAL_OUTCOME_UNKNOWN";
    return NextResponse.json({ code: safeCode, error: messages[safeCode] }, { status });
  };
  // Chat has a 120-second server deadline covering multiple AI/tool rounds.
  // Financial operations can perform OAuth plus several bounded 15s PayPal
  // requests. A 10s cutoff can hide a refund that PayPal already completed.
  const timeoutMs = shoppingChat
    ? 130_000
    : financialMutation
      ? 70_000
      : pathname === "mandates/parse"
        ? 60_000
        : 10_000;
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
    if (financialMutation) {
      return financialFailure("PAYPAL_OUTCOME_UNKNOWN", timeoutSignal.aborted ? 504 : 503);
    }
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
    if (financialMutation) {
      const payload = (await upstream.json().catch(() => null)) as { code?: unknown } | null;
      return financialFailure(
        typeof payload?.code === "string" ? payload.code : "",
        upstream.status === 504 ? 504 : 503,
      );
    }
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
        SHOPPING_AI_NOT_CONFIGURED:
          "The AI service is not configured, so the shopping assistant can’t reply. You can still browse the Demo Catalog in Discover.",
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
    const payload = (await upstream.json().catch(() => null)) as { code?: unknown } | null;
    if (payload?.code === "AI_NOT_CONFIGURED") {
      return NextResponse.json(
        {
          code: "AI_NOT_CONFIGURED",
          error:
            "The AI service is not configured yet. An administrator needs to add the AI provider settings.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "The service is temporarily unavailable. Try again shortly." },
      { status: 503 },
    );
  }

  if (
    shoppingStream &&
    upstream.ok &&
    upstream.body &&
    upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
  ) {
    const response = new NextResponse(relayEventStream(upstream.body, timeoutSignal), {
      status: upstream.status,
    });
    copyResponseHeaders(upstream, response);
    // No proxy, CDN or compression layer may buffer or transform live progress.
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    response.headers.set("cache-control", "no-cache, no-transform");
    response.headers.set("x-accel-buffering", "no");
    return response;
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
  });
  copyResponseHeaders(upstream, response);
  return response;
}
