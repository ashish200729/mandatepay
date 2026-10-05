import { redirect } from "next/navigation";
import { AuthSurface } from "@/components/auth-surface";
import { SignInForm } from "@/components/sign-in-form";
import { getAdminSession } from "@/lib/server-session";
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
    >
      {state === "expired" && (
        <p role="status" className="mb-5 rounded-xl border bg-secondary p-3 text-sm">
          Your admin session expired. Sign in again to continue.
        </p>
      )}
      {session.status === "unavailable" && (
        <p role="alert" className="mb-5 rounded-xl border p-3 text-sm">
          The session service is temporarily unavailable. Try signing in again shortly.
        </p>
      )}
      <SignInForm />
    </AuthSurface>
  );
}
