import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { getAuthLink, getSafeReturnTo } from "@/lib/auth/return-to";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; returnTo?: string | string[] }>;
}) {
  const params = await searchParams;
  const failed = Boolean(params.error);
  const returnTo = getSafeReturnTo(
    typeof params.returnTo === "string" ? params.returnTo : undefined,
  );
  return (
    <AuthShell
      eyebrow="Email verification"
      heading={failed ? "Let’s try again." : "You’re ready to sign in."}
      description={
        failed
          ? "This verification link is invalid or has expired. Sign in to request a fresh verification email."
          : "Your email verification is complete. Sign in to continue to your workspace."
      }
    >
      <Link
        href={getAuthLink("/signin", returnTo)}
        className="block rounded-xl bg-primary px-5 py-3 text-center text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        Back to sign in
      </Link>
    </AuthShell>
  );
}
