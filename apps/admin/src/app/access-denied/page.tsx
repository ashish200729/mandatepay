import Link from "next/link";
import { AuthSurface } from "@/components/auth-surface";
import { buttonVariants } from "@mandatepay/ui/components/button";
export default function AccessDenied() {
  return (
    <AuthSurface
      title="Admin access required"
      description="This account does not have active administrator access. Sign in with the configured main admin account."
    >
      <Link className={buttonVariants()} href="/login">
        Use another account
      </Link>
    </AuthSurface>
  );
}
