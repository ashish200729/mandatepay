"use client";
import { AuthSurface } from "@/components/auth-surface";
import { Button } from "@mandatepay/ui/components/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <AuthSurface
      title="Administration unavailable"
      description="We could not complete this request. Try again shortly."
    >
      <Button onClick={reset}>Try again</Button>
    </AuthSurface>
  );
}
