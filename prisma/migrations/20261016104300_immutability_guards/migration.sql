-- Immutability guards enforced by PostgreSQL itself (defence in depth beyond application code).

-- 1. Audit log is append-only. Retention purges run as a dedicated function that bypasses
--    the guard via a transaction-local setting, and are themselves audited.
CREATE OR REPLACE FUNCTION ncc_block_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ncc.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION ncc_block_audit_mutation();

-- 2. Campaign snapshots can never be changed or removed.
CREATE OR REPLACE FUNCTION ncc_block_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'campaign_snapshots are immutable (% blocked)', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "campaign_snapshots"
  FOR EACH ROW EXECUTE FUNCTION ncc_block_snapshot_mutation();

-- 3. Once a campaign's snapshot exists, its recipients and message assignments are frozen.
CREATE OR REPLACE FUNCTION ncc_block_frozen_audience() RETURNS trigger AS $$
DECLARE
  cid text;
BEGIN
  cid := COALESCE(NEW."campaign_id", OLD."campaign_id");
  IF EXISTS (SELECT 1 FROM "campaign_snapshots" s WHERE s."campaign_id" = cid) THEN
    RAISE EXCEPTION 'audience for campaign % is frozen (% on % blocked)', cid, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_recipients_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION ncc_block_frozen_audience();

CREATE TRIGGER campaign_message_assignments_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "campaign_message_assignments"
  FOR EACH ROW EXECUTE FUNCTION ncc_block_frozen_audience();

-- 4. Case-insensitive uniqueness of active category names (archived names may be reused).
CREATE UNIQUE INDEX "categories_active_name_ci_key"
  ON "categories" (lower("name")) WHERE "archived_at" IS NULL;

-- 5. One active suppression per identifier per channel scope.
CREATE UNIQUE INDEX "suppression_entries_active_channel_key"
  ON "suppression_entries" ("identifier_type", "identifier_value", "channel")
  WHERE "lifted_at" IS NULL AND "channel" IS NOT NULL;

CREATE UNIQUE INDEX "suppression_entries_active_all_key"
  ON "suppression_entries" ("identifier_type", "identifier_value")
  WHERE "lifted_at" IS NULL AND "channel" IS NULL;
