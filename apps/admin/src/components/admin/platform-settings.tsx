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
  const active = settings.find((item) => item.key === openKey) ?? null;
  const nextValue = active ? !active.value : false;

  async function ensureFresh() {
    const response = await fetch("/api/admin/me", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const admin = parseAdminMe(await response.json().catch(() => null));
    if (admin) setFresh(admin.session.freshAuthUntil);
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
      {PLATFORM_SETTING_GROUPS.map((group) => (
        <section key={group} aria-labelledby={`settings-${group}`} className="space-y-4">
          <h2 id={`settings-${group}`} className="text-lg font-medium">
            {group}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {settings
              .filter((setting) => setting.group === group)
              .map((setting) => (
                <article key={setting.key} className="rounded-2xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-medium">{setting.title}</h3>
                    <span className="rounded-full border px-2 py-1 text-xs">
                      {setting.value ? "On" : "Off"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{setting.description}</p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Version {setting.version}
                    {setting.critical ? " · Confirmation and a fresh sign-in are required" : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {setting.updatedAt
                      ? `Last changed ${formatUpdated(setting.updatedAt)} UTC by administrator ${setting.updatedByAdminId}.`
                      : "Default value. An administrator has not changed this control."}
                  </p>
                  <Button
                    type="button"
                    variant={setting.value && setting.critical ? "default" : "outline"}
                    className="mt-4"
                    onClick={() => {
                      void (async () => {
                        if (setting.critical) await ensureFresh();
                        setOpenKey(setting.key);
                      })();
                    }}
                  >
                    Turn {setting.title} {setting.value ? "off" : "on"}
                  </Button>
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
