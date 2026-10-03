-- Backfill only legacy rows created before canonicalRules existed. The
-- immutable trigger is disabled for this one migration-controlled repair and
-- re-enabled before the migration completes. Conservative defaults avoid
-- inventing permissions from incomplete historical rule data.
ALTER TABLE "MandateVersion" DISABLE TRIGGER mandate_version_immutable_history;

UPDATE "MandateVersion"
SET "canonicalRules" = jsonb_strip_nulls(
  jsonb_build_object(
    'title', "title",
    'productIntent', "title",
    'currency', "currency",
    'timezone', 'UTC',
    'allowedBrands', '[]'::jsonb,
    'blockedBrands', '[]'::jsonb,
    'allowedCategories', '[]'::jsonb,
    'blockedCategories', '[]'::jsonb,
    'allowedConditions', jsonb_build_array('NEW'),
    'autoSpendLimit', "autoSpendLimit",
    'transactionLimit', "transactionLimit",
    'dailyLimit', "dailyLimit",
    'weeklyLimit', "weeklyLimit",
    'monthlyLimit', "monthlyLimit",
    'quantityLimit', 1,
    'allowedMerchants', '[]'::jsonb,
    'blockedMerchants', '[]'::jsonb,
    'newMerchantRequiresApproval', true,
    'startsAt', to_char("startsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char("expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
)
WHERE "canonicalRules" IS NULL;

ALTER TABLE "MandateVersion" ENABLE TRIGGER mandate_version_immutable_history;
