import { getAdminSession } from "@/lib/server-session";
import { redirect } from "next/navigation";
import { SessionControls } from "@/components/session-controls";
import { AuthSurface } from "@/components/auth-surface";
export default async function AdminHome() {
  const result = await getAdminSession();
  if (result.status !== "authenticated") redirect("/login?state=expired");
  return (
    <AuthSurface
      title="Your admin session"
      description="Secure access is ready. Operational pages will be added in the next implementation phases."
    >
      <dl className="space-y-3 break-words text-sm">
        <div>
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd className="mt-1 font-medium">{result.admin.user.email}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Role</dt>
          <dd className="mt-1">Main administrator</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Session security</dt>
          <dd className="mt-1">30-minute idle timeout · 10-minute password confirmation</dd>
        </div>
      </dl>
      <SessionControls />
    </AuthSurface>
  );
}
