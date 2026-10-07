import { redirect } from "next/navigation";
import { safeBuild } from "@mandatepay/shared";
import { getAdminSession } from "@/lib/server-session";
import { AuthSurface } from "@/components/auth-surface";
import { AdminShell } from "@/components/admin/admin-shell";
import { adminEnvironment } from "@/lib/environment";
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const result = await getAdminSession();
  if (result.status === "expired") redirect("/login?state=expired");
  if (result.status === "denied") redirect("/access-denied");
  if (result.status !== "authenticated")
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
  return (
    <AdminShell
      admin={result.admin}
      environment={adminEnvironment(process.env.ADMIN_ENVIRONMENT, process.env.ADMIN_ORIGIN)}
      commitSha={
        safeBuild({
          commitSha: process.env.MANDATEPAY_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null,
          version: null,
        }).commitSha
      }
    >
      {children}
    </AdminShell>
  );
}
