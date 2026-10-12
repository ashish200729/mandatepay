import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { isIP } from "node:net";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/** Client address asserted by the web/admin BFF. Trusted only with a matching proxy secret. */
export const CLIENT_IP_HEADER = "x-mandatepay-client-ip";
/** Shared secret proving that the request came from a MandatePay BFF. */
export const PROXY_SECRET_HEADER = "x-mandatepay-proxy-secret";

type HeaderValue = string | string[] | undefined;

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison; hashing first avoids leaking the configured secret's length. */
export function internalProxySecretMatches(
  provided: HeaderValue,
  expected: string | undefined,
): boolean {
  if (!expected || typeof provided !== "string" || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function normalizeClientIp(value: HeaderValue): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length <= 64 && isIP(candidate) ? candidate : null;
}

/**
 * The BFF-asserted client address is used only when the shared secret matches. Otherwise the
 * socket address (or the TRUST_PROXY-derived address) remains authoritative.
 */
export function resolveClientIp(
  headers: Record<string, HeaderValue>,
  fallback: string,
  secret: string | undefined,
): string {
  if (!internalProxySecretMatches(headers[PROXY_SECRET_HEADER], secret)) return fallback;
  return normalizeClientIp(headers[CLIENT_IP_HEADER]) ?? fallback;
}

/**
 * Pins `request.ip` to the resolved client address so every limiter, including Better Auth's
 * and the admin scope's, keys on the same value. The internal headers are removed so they are
 * never forwarded to Better Auth or exposed to handlers.
 */
export function pinClientIp(request: FastifyRequest, secret: string | undefined) {
  const clientIp = resolveClientIp(request.headers, request.ip, secret);
  for (const name of [PROXY_SECRET_HEADER, CLIENT_IP_HEADER]) {
    delete request.headers[name];
    delete request.raw.headers[name];
  }
  Object.defineProperty(request, "ip", {
    value: clientIp,
    enumerable: true,
    configurable: true,
    writable: false,
  });
}

/**
 * Fastify fails closed for numeric hop counts, so express the count as a function: trust the
 * nearest `hops` proxies. Use only when the API is reachable exclusively through those proxies.
 */
export function trustProxyHops(hops: number | undefined) {
  if (!hops) return false;
  return (_address: string, hop: number) => hop < hops;
}

export function apiSecurityHeaders(production: boolean): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-site",
    ...(production ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

export function applySecurityHeaders(reply: FastifyReply, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) {
    if (!reply.hasHeader(name)) reply.header(name, value);
  }
}

/** Separates the product-context HMAC key from Better Auth's session secret. */
export function deriveProductContextSecret(authSecret: string): string {
  return Buffer.from(
    hkdfSync("sha256", authSecret, "mandatepay", "mandatepay/shopping-product-context/v1", 32),
  ).toString("hex");
}

function errorStatus(error: { statusCode?: unknown; status?: unknown }): number {
  const status = typeof error.statusCode === "number" ? error.statusCode : error.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : 500;
}

/**
 * Global fallback for errors not handled by a route. Client errors raised by Fastify itself keep
 * its safe code/message; everything else is generic so internal details never reach callers.
 */
export function sendUnhandledError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const status = errorStatus(error);
  if (status < 500) {
    request.log.warn(
      { err: error, requestId: request.id, event: "request_rejected" },
      "Request rejected",
    );
    const fastifyError = typeof error.code === "string" && error.code.startsWith("FST_");
    const validation = Array.isArray(error.validation);
    return reply.status(status).send({
      error: fastifyError || validation ? error.message : (STATUS_CODES[status] ?? "Bad Request"),
      code: fastifyError ? error.code : validation ? "INVALID_REQUEST" : "REQUEST_REJECTED",
      requestId: request.id,
    });
  }
  request.log.error(
    { err: error, requestId: request.id, event: "unhandled_error" },
    "Unhandled request error",
  );
  return reply.status(500).send({ error: "INTERNAL_ERROR", requestId: request.id });
}

export function sendNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ error: "Not found", code: "NOT_FOUND", requestId: request.id });
}
