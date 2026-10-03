import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const token =
    typeof params.token === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(params.token)
      ? params.token
      : undefined;
  return (
    <AuthShell
      eyebrow="Account recovery"
      heading="A fresh start."
      description="Choose a new password with at least 8 characters. Updating it will sign out your existing sessions."
    >
      <PasswordResetForm mode="reset" token={token} invalidToken={Boolean(params.error)} />
    </AuthShell>
  );
}
