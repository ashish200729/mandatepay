import { redirect } from "next/navigation";
import { AuthSurface } from "@/components/auth-surface";
import { SignInForm } from "@/components/sign-in-form";
import { getAdminSession } from "@/lib/server-session";
import { adminEnvironment } from "@/lib/environment";
import { AlertCircle, Clock3 } from "lucide-react";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const session = await getAdminSession();
  if (session.status === "authenticated") redirect("/");
  const { state } = await searchParams;
  return (
    <AuthSurface
      title="Sign in to admin"
      description="A verified administrator account is required to access MandatePay administration."
      environment={adminEnvironment(process.env.ADMIN_ENVIRONMENT, process.env.ADMIN_ORIGIN)}
    >
      {state === "expired" && (
        <p
          role="status"
          className="mb-5 flex items-start gap-2.5 rounded-lg border bg-secondary/50 p-3 text-sm leading-6"
        >
          <Clock3 size={17} className="mt-1 shrink-0" aria-hidden="true" />
          <span>Your admin session expired. Sign in again to continue.</span>
        </p>
      )}
      {session.status === "unavailable" && (
        <p
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-lg border border-admin-warning-foreground/20 bg-admin-warning p-3 text-sm leading-6 text-admin-warning-foreground"
        >
          <AlertCircle size={17} className="mt-1 shrink-0" aria-hidden="true" />
          <span>The session service is temporarily unavailable. Try signing in again shortly.</span>
        </p>
      )}
      <SignInForm />
    </AuthSurface>
  );
}
