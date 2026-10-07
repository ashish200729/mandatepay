import { PageHeader } from "@/components/admin/page-header";
import { PlatformSettings } from "@/components/admin/platform-settings";
import { adminApi } from "@/lib/admin-fetch";
import { parseAdminList, parseAdminPlatformSetting } from "@mandatepay/shared";
import { ParseAlert } from "@/components/admin/health-card";

export default async function SettingsPage() {
  const response = await adminApi("/api/admin/settings");
  const settings = parseAdminList(response.json, parseAdminPlatformSetting);
  return (
    <>
      <PageHeader
        title="Platform controls"
        description="Manage purchasing, shopping and platform availability. Changes require confirmation."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Configuration" }]}
      />
      {!settings ? (
        <ParseAlert
          message="Platform controls could not be loaded. Customer financial actions should be treated as unavailable until this page loads."
          href="/settings"
        />
      ) : (
        <PlatformSettings settings={settings.data} />
      )}
    </>
  );
}
