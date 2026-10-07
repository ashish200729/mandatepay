"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import {
  DangerConfirmDialog,
  ReasonDialog,
  type ActionConfirmation,
} from "@/components/admin/action-dialogs";
import { postAdminControl } from "@/lib/admin-action";
import { parseAdminMe } from "@/lib/session";
import { StatusBadge } from "./status-badge";
import { LockKeyhole, Settings2 } from "lucide-react";
import {
  PLATFORM_SETTING_GROUPS,
  type AdminPlatformSetting,
  type PlatformSettingKey,
} from "@mandatepay/shared";

function formatUpdated(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function PlatformSettings({ settings }: { settings: AdminPlatformSetting[] }) {
  const router = useRouter();
  const [openKey, setOpenKey] = useState<PlatformSettingKey | null>(null);
  const [fresh, setFresh] = useState<string | undefined>();
  const [checking, setChecking] = useState<PlatformSettingKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = settings.find((item) => item.key === openKey) ?? null;
  const nextValue = active ? !active.value : false;

  async function ensureFresh() {
    const response = await fetch("/api/admin/me", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const admin = parseAdminMe(await response.json().catch(() => null));
    if (!response.ok || !admin) throw new Error("Session verification unavailable");
    setFresh(admin.session.freshAuthUntil);
  }

  async function save(setting: AdminPlatformSetting, input: ActionConfirmation) {
    const saved = await postAdminControl(
      `settings/${encodeURIComponent(setting.key)}`,
      {
        value: !setting.value,
        expectedVersion: setting.version,
        reason: input.reason,
        confirmation: true,
        requestKey: input.requestKey,
        ...(setting.critical ? { typedConfirmation: input.confirmation } : {}),
      },
      "PATCH",
    );
    router.refresh();
    return saved;
  }

  return (
    <div className="space-y-10">
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-admin-danger-foreground/20 bg-admin-danger p-4 text-sm text-admin-danger-foreground"
        >
          {error}
        </p>
      )}
      {PLATFORM_SETTING_GROUPS.map((group) => (
        <section key={group} aria-labelledby={`settings-${group}`} className="space-y-4">
          <h2 id={`settings-${group}`} className="flex items-center gap-2 text-base font-medium">
            <Settings2 size={17} aria-hidden="true" />
            {group}
          </h2>
          <div className="overflow-hidden rounded-xl border bg-card divide-y">
            {settings
              .filter((setting) => setting.group === group)
              .map((setting) => (
                <article
                  key={setting.key}
                  className="grid min-w-0 gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-sm font-medium">{setting.title}</h3>
                      <StatusBadge
                        status={setting.value ? "ON" : "OFF"}
                        label={setting.value ? "On" : "Off"}
                        tone={
                          setting.key === "platform.maintenanceMode"
                            ? setting.value
                              ? "warning"
                              : "neutral"
                            : setting.value
                              ? "success"
                              : "neutral"
                        }
                      />
                    </div>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      {setting.description}
                    </p>
                    <details className="mt-2 text-xs leading-5 text-muted-foreground">
                      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded underline decoration-border">
                        Last change
                      </summary>
                      <p>
                        Version {setting.version}
                        {setting.critical ? " · Confirmation and a fresh sign-in are required" : ""}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                        {setting.updatedAt
                          ? `Last changed ${formatUpdated(setting.updatedAt)} UTC by administrator ${setting.updatedByAdminId}.`
                          : "Default value. An administrator has not changed this control."}
                      </p>
                    </details>
                  </div>
                  <div className="flex items-start lg:pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-w-32 rounded-lg"
                      disabled={checking !== null}
                      onClick={() => {
                        void (async () => {
                          setChecking(setting.key);
                          setError(null);
                          try {
                            if (setting.critical) await ensureFresh();
                            setOpenKey(setting.key);
                          } catch {
                            setFresh(undefined);
                            setError(
                              "Could not verify your admin session. Try the action again shortly.",
                            );
                          } finally {
                            setChecking(null);
                          }
                        })();
                      }}
                    >
                      {setting.critical && <LockKeyhole size={14} aria-hidden="true" />}
                      {checking === setting.key ? (
                        "Checking session…"
                      ) : (
                        <>
                          Turn {setting.title} {setting.value ? "off" : "on"}
                        </>
                      )}
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        </section>
      ))}
      {active &&
        (active.critical ? (
          <DangerConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setOpenKey(null);
            }}
            title={`Turn ${active.title} ${nextValue ? "on" : "off"}`}
            description={active.description}
            target={{ id: active.key, label: active.title }}
            actionLabel={`Turn ${nextValue ? "on" : "off"}`}
            intentKey={`${active.key}:${active.version}:${String(nextValue)}`}
            freshAuthUntil={fresh}
            onConfirm={(input) => save(active, input)}
          />
        ) : (
          <ReasonDialog
            open
            onOpenChange={(open) => {
              if (!open) setOpenKey(null);
            }}
            title={`Turn ${active.title} ${nextValue ? "on" : "off"}`}
            description={active.description}
            target={{ id: active.key, label: active.title }}
            actionLabel={`Turn ${nextValue ? "on" : "off"}`}
            intentKey={`${active.key}:${active.version}:${String(nextValue)}`}
            onConfirm={(input) => save(active, input)}
          />
        ))}
    </div>
  );
}
