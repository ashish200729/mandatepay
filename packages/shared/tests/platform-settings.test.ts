import { describe, expect, it } from "vitest";
import { ADMIN_SETTING_KEYS } from "../src/admin-audit.js";
import {
  AdminPlatformSettingMutationSchema,
  CRITICAL_PLATFORM_SETTING_KEYS,
  PLATFORM_SETTING_DEFAULTS,
  PLATFORM_SETTING_FAIL_CLOSED,
  describePlatformMode,
  presentPlatformSetting,
  resolvePlatformControls,
  restrictiveControlCount,
} from "../src/platform-settings.js";

describe("platform setting registry", () => {
  it("validates boolean values and rejects unknown keys or extra fields", () => {
    expect(
      AdminPlatformSettingMutationSchema.parse({
        value: false,
        expectedVersion: 0,
        reason: "Pause checkout during a provider incident.",
        confirmation: true,
        requestKey: "6d9f4c2a-7b21-4e8a-9c11-0a5b6d7e8f90",
        typedConfirmation: "payments.checkoutEnabled",
      }).value,
    ).toBe(false);
    expect(
      AdminPlatformSettingMutationSchema.safeParse({
        value: "false",
        expectedVersion: 0,
        reason: "Pause checkout during a provider incident.",
        confirmation: true,
        requestKey: "6d9f4c2a-7b21-4e8a-9c11-0a5b6d7e8f90",
      }).success,
    ).toBe(false);
    expect(
      AdminPlatformSettingMutationSchema.safeParse({
        value: false,
        expectedVersion: 0,
        reason: "Pause checkout during a provider incident.",
        confirmation: true,
        requestKey: "6d9f4c2a-7b21-4e8a-9c11-0a5b6d7e8f90",
        environment: "PAYPAL_CLIENT_SECRET",
      }).success,
    ).toBe(false);
  });

  it("fails closed on an unreadable store without stopping webhook processing", () => {
    const closed = resolvePlatformControls(null);
    expect(closed["payments.checkoutEnabled"]).toBe(false);
    expect(closed["payments.autonomyEnabledGlobally"]).toBe(false);
    expect(closed["payments.refundsEnabled"]).toBe(false);
    expect(closed["platform.maintenanceMode"]).toBe(true);
    expect(closed["agent.enabled"]).toBe(false);
    expect(closed["workers.webhookProcessingEnabled"]).toBe(true);
    expect(PLATFORM_SETTING_FAIL_CLOSED["workers.webhookProcessingEnabled"]).toBe(true);
  });

  it("uses defaults for missing keys and fail-closed values for invalid JSON", () => {
    const controls = resolvePlatformControls([
      { key: "payments.checkoutEnabled", valueJson: false },
      { key: "payments.refundsEnabled", valueJson: { enabled: true } },
      { key: "not.a.setting", valueJson: false },
    ]);
    expect(controls["payments.checkoutEnabled"]).toBe(false);
    expect(controls["payments.refundsEnabled"]).toBe(false);
    expect(controls["agent.enabled"]).toBe(PLATFORM_SETTING_DEFAULTS["agent.enabled"]);
    expect(restrictiveControlCount(controls)).toBe(2);
    expect(describePlatformMode(controls).length).toBeLessThanOrEqual(300);
    expect(describePlatformMode(PLATFORM_SETTING_DEFAULTS)).toContain("Normal operation");
  });

  it("presents every registry key and marks critical controls", () => {
    const presented = ADMIN_SETTING_KEYS.map((key) => presentPlatformSetting(key, null));
    expect(presented).toHaveLength(ADMIN_SETTING_KEYS.length);
    expect(presented.every((item) => item.version === 0)).toBe(true);
    expect(
      presented
        .filter((item) => item.critical)
        .map((item) => item.key)
        .sort(),
    ).toEqual([...CRITICAL_PLATFORM_SETTING_KEYS].sort());
    const stored = presentPlatformSetting("payments.checkoutEnabled", {
      valueJson: false,
      version: 2,
      updatedByAdminId: "6d9f4c2a-7b21-4e8a-9c11-0a5b6d7e8f90",
      updatedAt: new Date("2026-10-07T00:00:00.000Z"),
    });
    expect(stored).toMatchObject({
      value: false,
      version: 2,
      updatedAt: "2026-10-07T00:00:00.000Z",
    });
  });

  it("keeps the fully restricted mode description within the overview reason limit", () => {
    const restricted = resolvePlatformControls(
      ADMIN_SETTING_KEYS.map((key) => ({
        key,
        valueJson: !PLATFORM_SETTING_DEFAULTS[key],
      })),
    );
    expect(describePlatformMode(restricted).length).toBeLessThanOrEqual(300);
    expect(restrictiveControlCount(restricted)).toBe(ADMIN_SETTING_KEYS.length);
  });
});
