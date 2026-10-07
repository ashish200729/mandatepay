import { LoaderCircle } from "lucide-react";
import { AdminWordmark } from "@/components/admin/wordmark";
export default function Loading() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-6">
      <div className="space-y-5 text-center">
        <AdminWordmark />
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle size={17} aria-hidden="true" className="motion-safe:animate-spin" />
          Checking admin access…
        </p>
      </div>
    </main>
  );
}
