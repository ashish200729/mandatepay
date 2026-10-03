import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { getServerSession } from "@/lib/auth/server-api";
import { getSafeReturnTo } from "@/lib/auth/return-to";

type SearchParams = Promise<{ returnTo?: string | string[] }>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const rawReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = getSafeReturnTo(rawReturnTo);

  if (await getServerSession()) {
    redirect(returnTo);
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      heading="Keep the final say."
      description="Sign in to review your mandates, approvals, and the decisions your agent has made on your behalf."
    >
      <AuthForm mode="sign-in" returnTo={returnTo} />
    </AuthShell>
  );
}
