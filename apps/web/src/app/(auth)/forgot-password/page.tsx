import { AuthShell } from "@/components/auth-shell";
import { PasswordResetForm } from "@/components/password-reset-form";

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account recovery"
      heading="Find your way back."
      description="Enter your account email and we’ll send a link to reset your password."
    >
      <PasswordResetForm mode="request" />
    </AuthShell>
  );
}
