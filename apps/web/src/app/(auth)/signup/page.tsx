import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { getServerSession } from "@/lib/auth/server-api";
import { getSafeReturnTo } from "@/lib/auth/return-to";

type SearchParams = Promise<{ returnTo?: string | string[] }>;

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const rawReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = getSafeReturnTo(rawReturnTo);

  if (await getServerSession()) {
    redirect(returnTo);
  }

  return (
    <AuthShell
      eyebrow="Start with a mandate"
      heading="A calmer way to spend."
      description="Create your account and set the boundaries your AI assistant should respect before it ever reaches payment."
    >
      <AuthForm mode="sign-up" returnTo={returnTo} />
    </AuthShell>
  );
}
