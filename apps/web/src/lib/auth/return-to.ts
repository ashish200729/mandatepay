const DEFAULT_RETURN_TO = "/chat";

const AUTHENTICATED_ROUTES = [
  "/chat",
  "/mandates",
  "/approvals",
  "/orders",
  "/proposals",
  "/dashboard",
  "/settings",
] as const;

function isAllowedRoute(pathname: string) {
  return AUTHENTICATED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

export function getSafeReturnTo(value: string | null | undefined) {
  if (!value || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const url = new URL(value, "http://mandatepay.local");

    if (url.origin !== "http://mandatepay.local" || !isAllowedRoute(url.pathname)) {
      return DEFAULT_RETURN_TO;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

export function getAuthLink(pathname: "/signin" | "/signup", returnTo: string) {
  return `${pathname}?returnTo=${encodeURIComponent(getSafeReturnTo(returnTo))}`;
}
