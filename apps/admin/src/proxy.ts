import { NextResponse, type NextRequest } from "next/server";
import { readAdminSession } from "./lib/server-session";

/** Both this routing guard and the server layout ask the authoritative API. */
export async function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-mandatepay-admin-authorized");
  if (!["/login", "/access-denied"].includes(request.nextUrl.pathname)) {
    const session = await readAdminSession(request.headers.get("cookie") ?? "");
    if (session.status === "expired")
      return NextResponse.redirect(new URL("/login?state=expired", request.url));
    if (session.status === "denied")
      return NextResponse.redirect(new URL("/access-denied", request.url));
    // The protected layout renders an unavailable state without exposing content.
  }
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };
