import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/server-session";
import { AuthSurface } from "@/components/auth-surface";
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const result = await getAdminSession();
  if (result.status === "expired") redirect("/login?state=expired");
  if (result.status === "denied") redirect("/access-denied");
  if (result.status === "unavailable")
    return (
      <AuthSurface
        title="Administration unavailable"
        description="We could not verify your admin session. Try again shortly."
      >
        <form action="/" method="get">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-xl border px-5"
          >
            Try again
          </button>
        </form>
      </AuthSurface>
    );
  return children;
}
