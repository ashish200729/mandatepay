-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" VARCHAR(64) NOT NULL,
    "valueJson" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedByAdminId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "PlatformSetting"
  ADD CONSTRAINT "PlatformSetting_key_check" CHECK (
    "key" IN (
      'platform.maintenanceMode',
      'platform.registrationEnabled',
      'agent.enabled',
      'agent.proposalCreationEnabled',
      'discovery.demoCatalogEnabled',
      'discovery.channel3Enabled',
      'payments.checkoutEnabled',
      'payments.refundsEnabled',
      'payments.autonomyEnabledGlobally',
      'workers.webhookProcessingEnabled'
    )
  ),
  ADD CONSTRAINT "PlatformSetting_value_check" CHECK (jsonb_typeof("valueJson") = 'boolean'),
  ADD CONSTRAINT "PlatformSetting_version_check" CHECK ("version" >= 1);

CREATE INDEX "PlatformSetting_updatedByAdminId_idx" ON "PlatformSetting"("updatedByAdminId");

ALTER TABLE "PlatformSetting"
  ADD CONSTRAINT "PlatformSetting_updatedByAdminId_fkey"
  FOREIGN KEY ("updatedByAdminId") REFERENCES "AdminPrincipal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
