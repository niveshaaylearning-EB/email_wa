-- Performance: match send jobs to Content Builder emails by legacy id, and per-client lookups.
CREATE INDEX IF NOT EXISTS "salesforce_assets_legacy_id_idx" ON "salesforce_assets" ((raw->'legacyData'->>'legacyId'));
CREATE INDEX IF NOT EXISTS "salesforce_tracking_events_subscriber_dataset_idx" ON "salesforce_tracking_events" ("subscriber_key", "dataset_id");
CREATE INDEX IF NOT EXISTS "salesforce_backup_datasets_current_idx" ON "salesforce_backup_datasets" ("kind", "status") WHERE "superseded_by_id" IS NULL;
