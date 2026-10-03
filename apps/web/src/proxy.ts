import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const pathname = request.nextUrl.pathname;
  const requestedPath = `${pathname}${request.nextUrl.search}`;

  // Overwrite the internal value on every matched request so callers cannot spoof it.
  headers.set("x-mandatepay-internal-pathname", requestedPath);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/chat/:path*",
    "/discover/:path*",
    "/mandates/:path*",
    "/approvals/:path*",
    "/proposals/:path*",
    "/orders/:path*",
    "/dashboard/:path*",
    "/settings/:path*",
  ],
};
