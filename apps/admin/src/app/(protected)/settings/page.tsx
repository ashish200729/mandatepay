import { PageHeader } from "@/components/admin/page-header";
import { PlatformSettings } from "@/components/admin/platform-settings";
import { adminApi } from "@/lib/admin-fetch";
import { parseAdminList, parseAdminPlatformSetting } from "@mandatepay/shared";

export default async function SettingsPage() {
  const response = await adminApi("/api/admin/settings");
  const settings = parseAdminList(response.json, parseAdminPlatformSetting);
  return (
    <>
      <PageHeader
        title="Platform controls"
        description="These switches are enforced by the API. Turning one off here is the same control a direct API call uses."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Configuration" }]}
      />
      {!settings ? (
        <p role="alert">
          Platform controls could not be loaded. Customer financial actions should be treated as
          unavailable until this page loads.
        </p>
      ) : (
        <PlatformSettings settings={settings.data} />
      )}
    </>
  );
}
