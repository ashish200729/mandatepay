import { AdminLink as Link } from "@/components/admin/link";
import { AuthSurface } from "@/components/auth-surface";
import { buttonVariants } from "@mandatepay/ui/components/button";
import { adminEnvironment } from "@/lib/environment";
export default function AccessDenied() {
  return (
    <AuthSurface
      title="Admin access required"
      description="This account does not have active administrator access. Sign in with the configured main admin account."
      environment={adminEnvironment(process.env.ADMIN_ENVIRONMENT, process.env.ADMIN_ORIGIN)}
    >
      <Link className={buttonVariants({ className: "h-12 w-full rounded-lg" })} href="/login">
        Use another account
      </Link>
    </AuthSurface>
  );
}
