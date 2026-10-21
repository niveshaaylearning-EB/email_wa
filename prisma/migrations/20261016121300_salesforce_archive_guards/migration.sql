-- Salesforce archive: immutability guards enforced by PostgreSQL (defence in depth).
-- Every guard can be bypassed only by an explicit, transaction-local retention purge flag
-- (SET LOCAL ncc.retention_purge = 'on'), matching the existing audit_logs convention.

CREATE OR REPLACE FUNCTION ncc_sf_purge_allowed() RETURNS boolean AS $$
BEGIN
  RETURN current_setting('ncc.retention_purge', true) = 'on';
END;
$$ LANGUAGE plpgsql;

-- 1. Archive audit log, manifests and evidence packages are append-only.
CREATE OR REPLACE FUNCTION ncc_sf_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND ncc_sf_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesforce_archive_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON "salesforce_archive_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_block_mutation();

CREATE TRIGGER salesforce_backup_manifests_immutable
  BEFORE UPDATE OR DELETE ON "salesforce_backup_manifests"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_block_mutation();

CREATE TRIGGER salesforce_evidence_packages_immutable
  BEFORE UPDATE OR DELETE ON "salesforce_evidence_packages"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_block_mutation();

-- 2. Extracted records are never updated. They may be deleted only while their dataset is
--    unsealed (an interrupted attempt being restarted) or by an explicit retention purge.
CREATE OR REPLACE FUNCTION ncc_sf_guard_extracted_record() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows are immutable (UPDATE blocked)', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF ncc_sf_purge_allowed() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "salesforce_backup_datasets" d WHERE d."id" = OLD."dataset_id" AND d."sealed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'dataset % is sealed (DELETE on % blocked)', OLD."dataset_id", TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesforce_data_extension_rows_guard
  BEFORE UPDATE OR DELETE ON "salesforce_data_extension_rows"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_extracted_record();

CREATE TRIGGER salesforce_tracking_events_guard
  BEFORE UPDATE OR DELETE ON "salesforce_tracking_events"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_extracted_record();

CREATE TRIGGER salesforce_subscribers_guard
  BEFORE UPDATE OR DELETE ON "salesforce_subscribers"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_extracted_record();

CREATE TRIGGER salesforce_backup_pages_guard
  BEFORE UPDATE OR DELETE ON "salesforce_backup_pages"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_extracted_record();

-- 3. A sealed dataset keeps its extraction facts. Only verification results, the independent
--    source count and the superseded pointer may change afterwards (re-verification).
CREATE OR REPLACE FUNCTION ncc_sf_guard_sealed_dataset() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sealed_at" IS NOT NULL AND NOT ncc_sf_purge_allowed() THEN
      RAISE EXCEPTION 'dataset % is sealed (DELETE blocked)', OLD."id" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."records_extracted" IS DISTINCT FROM OLD."records_extracted"
    OR NEW."pages_fetched" IS DISTINCT FROM OLD."pages_fetched"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."params" IS DISTINCT FROM OLD."params"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."mid" IS DISTINCT FROM OLD."mid"
    OR NEW."source_key" IS DISTINCT FROM OLD."source_key"
    OR NEW."object_type" IS DISTINCT FROM OLD."object_type"
    OR NEW."connection_id" IS DISTINCT FROM OLD."connection_id"
    OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
    OR NEW."is_simulated" IS DISTINCT FROM OLD."is_simulated"
  ) THEN
    RAISE EXCEPTION 'dataset % is sealed; extraction facts cannot change', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesforce_backup_datasets_sealed
  BEFORE UPDATE OR DELETE ON "salesforce_backup_datasets"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_sealed_dataset();

-- 4. Completed reconciliation results are frozen evidence (re-runs create a new job).
CREATE OR REPLACE FUNCTION ncc_sf_guard_recon_result() RETURNS trigger AS $$
BEGIN
  IF ncc_sf_purge_allowed() THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  IF EXISTS (SELECT 1 FROM "salesforce_reconciliation_jobs" j
             WHERE j."id" = COALESCE(NEW."reconciliation_id", OLD."reconciliation_id") AND j."status" = 'COMPLETED') THEN
    RAISE EXCEPTION 'reconciliation % is completed (% blocked)', COALESCE(NEW."reconciliation_id", OLD."reconciliation_id"), TG_OP
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesforce_reconciliation_results_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "salesforce_reconciliation_results"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_recon_result();

CREATE OR REPLACE FUNCTION ncc_sf_guard_recon_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'COMPLETED' AND NOT ncc_sf_purge_allowed() THEN
      RAISE EXCEPTION 'reconciliation % is completed (DELETE blocked)', OLD."id" USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION 'reconciliation % is completed (UPDATE blocked)', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesforce_reconciliation_jobs_frozen
  BEFORE UPDATE OR DELETE ON "salesforce_reconciliation_jobs"
  FOR EACH ROW EXECUTE FUNCTION ncc_sf_guard_recon_job();

-- 5. Search helpers: JSONB containment lookups on archived DE rows, and a BRIN index for
--    time-range scans over the (append-only, roughly time-ordered) tracking table.
CREATE INDEX "salesforce_data_extension_rows_values_gin" ON "salesforce_data_extension_rows" USING GIN ("values" jsonb_path_ops);
CREATE INDEX "salesforce_tracking_events_event_date_brin" ON "salesforce_tracking_events" USING BRIN ("event_date");
