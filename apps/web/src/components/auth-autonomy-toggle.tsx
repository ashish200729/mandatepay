"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, ShieldCheck } from "lucide-react";

type SettingsResponse =
  | {
      user: { autonomousPurchasingEnabled: boolean };
      changed?: boolean;
    }
  | {
      autonomousPurchasingEnabled: boolean;
    };

function readSettingsResponse(value: unknown): SettingsResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("The settings response was not valid.");
  }

  const record = value as Record<string, unknown>;
  const user = record.user;
  const enabled =
    typeof user === "object" && user !== null
      ? (user as Record<string, unknown>).autonomousPurchasingEnabled
      : record.autonomousPurchasingEnabled;

  if (typeof enabled !== "boolean") {
    throw new Error("The settings response was not valid.");
  }

  return user && typeof user === "object"
    ? {
        user: { autonomousPurchasingEnabled: enabled },
        changed: record.changed as boolean | undefined,
      }
    : { autonomousPurchasingEnabled: enabled };
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const message =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : "We couldn’t update this permission. Try again.";

  return message.slice(0, 180);
}

export function AuthAutonomyToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const id = useId();
  const descriptionId = `${id}-description`;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updatePermission(nextEnabled: boolean) {
    if (pending || nextEnabled === enabled) return;

    const previous = enabled;
    setEnabled(nextEnabled);
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ autonomousPurchasingEnabled: nextEnabled }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = readSettingsResponse(await response.json().catch(() => null));
      setEnabled(
        "user" in payload
          ? payload.user.autonomousPurchasingEnabled
          : payload.autonomousPurchasingEnabled,
      );
      router.refresh();
    } catch (cause) {
      setEnabled(previous);
      setError(cause instanceof Error ? cause.message : "We couldn’t update this permission.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sand">
          <ShieldCheck size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-editorial text-2xl tracking-[-0.02em]">
                Automatic purchase permissions
              </h2>
              <p
                id={descriptionId}
                className="mt-2 max-w-[470px] text-sm leading-[1.75] text-muted-foreground"
              >
                Allow proposals inside an active mandate&apos;s limits to proceed without an extra
                approval. PayPal may still ask for buyer approval, and hard policy violations always
                remain blocked.
              </p>
            </div>
            <label className="relative inline-flex min-h-11 w-12 shrink-0 cursor-pointer items-center">
              <span className="sr-only">Automatic purchase permissions</span>
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={pending}
                aria-describedby={descriptionId}
                onChange={(event) => void updatePermission(event.currentTarget.checked)}
                className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none relative h-7 w-12 rounded-full bg-border transition-colors after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-card after:shadow-[0_1px_3px_rgba(27,20,14,0.18)] after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-5 peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50 motion-reduce:transition-none motion-reduce:after:transition-none"
              />
            </label>
          </div>
          <div
            className="mt-7 flex min-h-6 items-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {pending ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            ) : null}
            <span>
              {pending
                ? "Saving permission…"
                : enabled
                  ? "Automatic permissions are on"
                  : "Automatic permissions are off"}
            </span>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-sm leading-relaxed text-foreground">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
