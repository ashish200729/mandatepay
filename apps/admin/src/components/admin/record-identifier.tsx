"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@mandatepay/ui/components/button";

export function RecordIdentifier({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground">Record ID</span>
        <code className="min-w-0 select-all break-all text-xs text-muted-foreground">{id}</code>
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Copy record ID"
        className="size-11 shrink-0 text-muted-foreground"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(id);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? (
          <Check size={15} aria-hidden="true" />
        ) : (
          <Copy size={15} aria-hidden="true" />
        )}
      </Button>
      {state === "copied" && (
        <span role="status" className="text-xs text-admin-success-foreground">
          Copied
        </span>
      )}
      {state === "failed" && (
        <span role="alert" className="text-xs text-admin-danger-foreground">
          Select the ID to copy it manually.
        </span>
      )}
    </div>
  );
}
