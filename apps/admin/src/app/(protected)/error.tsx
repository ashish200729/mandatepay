"use client";
import { ErrorState } from "@/components/admin/states";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <ErrorState title="Could not load this page" onRetry={reset} />;
}
