-- Declare every archive index in schema.prisma so `prisma migrate dev` can no longer drop them.
-- (An earlier generated migration silently dropped hand-written GIN/BRIN indexes.)

-- Replace hand-written indexes with schema-declared equivalents.
DROP INDEX IF EXISTS "salesforce_backup_datasets_current_idx";
DROP INDEX IF EXISTS "salesforce_assets_legacy_id_idx";

-- Content Builder legacy id as a real column (was an expression index on raw JSON).
ALTER TABLE "salesforce_assets" ADD COLUMN "legacy_id" TEXT;
UPDATE "salesforce_assets" SET "legacy_id" = raw->'legacyData'->>'legacyId' WHERE raw->'legacyData'->>'legacyId' IS NOT NULL;
CREATE INDEX "salesforce_assets_connection_id_mid_legacy_id_idx" ON "salesforce_assets"("connection_id", "mid", "legacy_id");

CREATE INDEX "salesforce_backup_datasets_current_idx" ON "salesforce_backup_datasets"("kind", "status", "superseded_by_id");

-- Value search over archived Data Extension rows (restored).
CREATE INDEX IF NOT EXISTS "salesforce_data_extension_rows_values_gin" ON "salesforce_data_extension_rows" USING GIN ("values" jsonb_path_ops);

-- salesforce_tracking_events_subscriber_dataset_idx already exists and is now declared in the schema.
