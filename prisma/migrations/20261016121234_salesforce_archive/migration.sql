-- CreateEnum
CREATE TYPE "SfConnectionKind" AS ENUM ('LIVE', 'SIMULATED');

-- CreateEnum
CREATE TYPE "SfConnectionStatus" AS ENUM ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "SfBackupMode" AS ENUM ('FULL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "SfBackupJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'CANCELLING', 'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_GAPS', 'FAILED');

-- CreateEnum
CREATE TYPE "SfDatasetKind" AS ENUM ('BUSINESS_UNITS', 'DATA_FOLDERS', 'DE_INVENTORY', 'DE_ROWS', 'SUBSCRIBERS', 'LISTS', 'EMAIL_JOBS', 'TRIGGERED_SENDS', 'TRACKING_SENT', 'TRACKING_OPEN', 'TRACKING_CLICK', 'TRACKING_BOUNCE', 'TRACKING_UNSUB', 'TRACKING_NOTSENT', 'JOURNEYS', 'AUTOMATIONS', 'QUERY_DEFINITIONS', 'CONTENT_ASSETS', 'CONTENT_CATEGORIES', 'AUDIENCE_UPLOAD');

-- CreateEnum
CREATE TYPE "SfDatasetStatus" AS ENUM ('PENDING', 'RUNNING', 'EXTRACTED', 'FAILED', 'CANCELLED', 'NOT_ACCESSIBLE', 'NOT_RETRIEVABLE');

-- CreateEnum
CREATE TYPE "SfVerificationStatus" AS ENUM ('VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'FAILED', 'NOT_ACCESSIBLE', 'NOT_RETRIEVABLE');

-- CreateEnum
CREATE TYPE "SfTrackingEventType" AS ENUM ('SENT', 'OPEN', 'CLICK', 'BOUNCE', 'UNSUB', 'NOTSENT');

-- CreateEnum
CREATE TYPE "SfReconStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SfReconClass" AS ENUM ('MATCHED_SENT', 'AUDIENCE_NO_SENT_EVENT', 'TRACKING_NOT_IN_AUDIENCE', 'DUPLICATE_AUDIENCE_ROW', 'INVALID_IDENTIFIER', 'RETENTION_UNAVAILABLE', 'UNRESOLVED');

-- AlterEnum
ALTER TYPE "RoleKey" ADD VALUE 'COMPLIANCE_OFFICER';

-- CreateTable
CREATE TABLE "salesforce_connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SfConnectionKind" NOT NULL DEFAULT 'LIVE',
    "status" "SfConnectionStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "auth_base_uri" TEXT,
    "rest_base_uri" TEXT,
    "soap_base_uri" TEXT,
    "enterprise_mid" TEXT,
    "default_mid" TEXT,
    "secrets_encrypted" TEXT,
    "secrets_hint" JSONB NOT NULL DEFAULT '{}',
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "account_info" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_tested_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "salesforce_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_business_units" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_mid" TEXT,
    "customer_key" TEXT,
    "is_enterprise" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesforce_business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_backup_jobs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mids" TEXT[],
    "mode" "SfBackupMode" NOT NULL DEFAULT 'FULL',
    "scope" JSONB NOT NULL,
    "status" "SfBackupJobStatus" NOT NULL DEFAULT 'QUEUED',
    "verification_status" "SfVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verification_notes" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "schedule_id" TEXT,
    "parent_job_id" TEXT,
    "created_by_id" TEXT,
    "created_by_email" TEXT,
    "cancel_requested_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesforce_backup_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_backup_schedules" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "mids" TEXT[],
    "interval_hours" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_job_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesforce_backup_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_backup_datasets" (
    "id" TEXT NOT NULL,
    "backup_job_id" TEXT,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "kind" "SfDatasetKind" NOT NULL,
    "object_type" TEXT NOT NULL,
    "source_key" TEXT,
    "label" TEXT NOT NULL,
    "status" "SfDatasetStatus" NOT NULL DEFAULT 'PENDING',
    "verification_status" "SfVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verification_details" JSONB NOT NULL DEFAULT '{}',
    "params" JSONB NOT NULL DEFAULT '{}',
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_extracted" INTEGER NOT NULL DEFAULT 0,
    "source_count" INTEGER,
    "source_count_method" TEXT,
    "api_calls" INTEGER NOT NULL DEFAULT 0,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "bytes_stored" BIGINT NOT NULL DEFAULT 0,
    "coverage_from" TIMESTAMP(3),
    "coverage_to" TIMESTAMP(3),
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "superseded_by_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "last_progress_at" TIMESTAMP(3),
    "sealed_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_backup_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_backup_pages" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "page_no" INTEGER NOT NULL,
    "record_count" INTEGER NOT NULL,
    "request_id" TEXT,
    "overall_status" TEXT,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_backup_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_backup_manifests" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "backup_job_id" TEXT,
    "dataset_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "manifest" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "previous_sha256" TEXT,
    "storage_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_backup_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_data_extensions" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "object_id" TEXT,
    "customer_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" TEXT,
    "folder_path" TEXT,
    "is_sendable" BOOLEAN,
    "is_testable" BOOLEAN,
    "sendable_field" TEXT,
    "retention" JSONB NOT NULL DEFAULT '{}',
    "created_date" TEXT,
    "modified_date" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "inventory_dataset_id" TEXT,
    "latest_rows_dataset_id" TEXT,
    "attested_count" INTEGER,
    "attested_by_id" TEXT,
    "attested_by_email" TEXT,
    "attested_at" TIMESTAMP(3),
    "attestation_note" TEXT,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_data_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_data_extension_fields" (
    "id" TEXT NOT NULL,
    "data_extension_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "field_type" TEXT,
    "max_length" TEXT,
    "scale" TEXT,
    "is_primary_key" BOOLEAN,
    "is_required" BOOLEAN,
    "ordinal" INTEGER,
    "default_value" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "salesforce_data_extension_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_data_extension_rows" (
    "id" BIGSERIAL NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "data_extension_id" TEXT,
    "page_no" INTEGER NOT NULL,
    "row_no" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "row_hash" TEXT NOT NULL,
    "primary_key" TEXT,

    CONSTRAINT "salesforce_data_extension_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_subscribers" (
    "id" BIGSERIAL NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "page_no" INTEGER NOT NULL,
    "row_no" INTEGER NOT NULL,
    "subscriber_key" TEXT,
    "subscriber_id" TEXT,
    "email_address" TEXT,
    "status" TEXT,
    "created_date" TEXT,
    "unsubscribed_date" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "salesforce_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_email_jobs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "email_id" TEXT,
    "email_name" TEXT,
    "subject" TEXT,
    "from_name" TEXT,
    "from_address" TEXT,
    "send_classification" TEXT,
    "status" TEXT,
    "send_date" TIMESTAMP(3),
    "sent_date" TIMESTAMP(3),
    "created_date" TEXT,
    "counters" JSONB NOT NULL DEFAULT '{}',
    "targets" JSONB NOT NULL DEFAULT '{}',
    "triggered_send_key" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "dataset_id" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_email_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_tracking_events" (
    "id" BIGSERIAL NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "event_type" "SfTrackingEventType" NOT NULL,
    "job_id" TEXT,
    "subscriber_key" TEXT,
    "subscriber_id" TEXT,
    "event_date" TIMESTAMP(3),
    "event_date_raw" TEXT,
    "batch_id" TEXT,
    "list_id" TEXT,
    "triggered_send_object_id" TEXT,
    "url" TEXT,
    "url_id" TEXT,
    "bounce_category" TEXT,
    "bounce_type" TEXT,
    "smtp_code" TEXT,
    "smtp_reason" TEXT,
    "source_event_type" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "fingerprint" TEXT NOT NULL,
    "page_no" INTEGER NOT NULL,
    "row_no" INTEGER NOT NULL,

    CONSTRAINT "salesforce_tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_assets" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "customer_key" TEXT,
    "name" TEXT,
    "asset_type" TEXT,
    "category_id" TEXT,
    "category_path" TEXT,
    "subject" TEXT,
    "preheader" TEXT,
    "created_date" TEXT,
    "modified_date" TEXT,
    "content_storage_key" TEXT,
    "content_sha256" TEXT,
    "content_bytes" INTEGER,
    "references" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "dataset_id" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_journeys" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "key" TEXT,
    "name" TEXT,
    "version" INTEGER NOT NULL,
    "status" TEXT,
    "definition_type" TEXT,
    "created_date" TEXT,
    "modified_date" TEXT,
    "entry_sources" JSONB NOT NULL DEFAULT '[]',
    "activities" JSONB NOT NULL DEFAULT '[]',
    "gaps" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "dataset_id" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_automations" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "customer_key" TEXT,
    "name" TEXT,
    "description" TEXT,
    "status" TEXT,
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "activities" JSONB NOT NULL DEFAULT '[]',
    "definition" TEXT,
    "gaps" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "dataset_id" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_reconciliation_jobs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connection_id" TEXT,
    "mid" TEXT NOT NULL,
    "job_ids" TEXT[],
    "send_date_from" TIMESTAMP(3),
    "send_date_to" TIMESTAMP(3),
    "audience_dataset_id" TEXT NOT NULL,
    "audience_source" TEXT NOT NULL,
    "audience_label" TEXT NOT NULL,
    "audience_evidence" JSONB NOT NULL DEFAULT '{}',
    "identity_mapping" JSONB NOT NULL,
    "status" "SfReconStatus" NOT NULL DEFAULT 'QUEUED',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "inputs_sha256" TEXT,
    "error_message" TEXT,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "salesforce_reconciliation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_reconciliation_results" (
    "id" BIGSERIAL NOT NULL,
    "reconciliation_id" TEXT NOT NULL,
    "identity" TEXT,
    "raw_identity" TEXT,
    "classification" "SfReconClass" NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audience_refs" JSONB NOT NULL DEFAULT '[]',
    "sent_event_count" INTEGER NOT NULL DEFAULT 0,
    "first_sent_at" TIMESTAMP(3),
    "evidence" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "salesforce_reconciliation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_evidence_packages" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "manifest_sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_evidence_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_extraction_errors" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT,
    "backup_job_id" TEXT,
    "dataset_id" TEXT,
    "mid" TEXT,
    "object_type" TEXT,
    "stage" TEXT NOT NULL,
    "http_status" INTEGER,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "page_no" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_extraction_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_extraction_logs" (
    "id" BIGSERIAL NOT NULL,
    "backup_job_id" TEXT,
    "dataset_id" TEXT,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_extraction_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_archive_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_archive_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_business_units_connection_id_mid_key" ON "salesforce_business_units"("connection_id", "mid");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_backup_jobs_code_key" ON "salesforce_backup_jobs"("code");

-- CreateIndex
CREATE INDEX "salesforce_backup_jobs_connection_id_created_at_idx" ON "salesforce_backup_jobs"("connection_id", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_backup_jobs_status_idx" ON "salesforce_backup_jobs"("status");

-- CreateIndex
CREATE INDEX "salesforce_backup_schedules_enabled_next_run_at_idx" ON "salesforce_backup_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "salesforce_backup_datasets_backup_job_id_idx" ON "salesforce_backup_datasets"("backup_job_id");

-- CreateIndex
CREATE INDEX "salesforce_backup_datasets_connection_id_mid_kind_source_ke_idx" ON "salesforce_backup_datasets"("connection_id", "mid", "kind", "source_key");

-- CreateIndex
CREATE INDEX "salesforce_backup_datasets_kind_status_idx" ON "salesforce_backup_datasets"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_backup_pages_dataset_id_attempt_page_no_key" ON "salesforce_backup_pages"("dataset_id", "attempt", "page_no");

-- CreateIndex
CREATE INDEX "salesforce_backup_manifests_backup_job_id_idx" ON "salesforce_backup_manifests"("backup_job_id");

-- CreateIndex
CREATE INDEX "salesforce_backup_manifests_dataset_id_idx" ON "salesforce_backup_manifests"("dataset_id");

-- CreateIndex
CREATE INDEX "salesforce_data_extensions_mid_customer_key_idx" ON "salesforce_data_extensions"("mid", "customer_key");

-- CreateIndex
CREATE INDEX "salesforce_data_extensions_name_idx" ON "salesforce_data_extensions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_data_extensions_connection_id_mid_customer_key_key" ON "salesforce_data_extensions"("connection_id", "mid", "customer_key");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_data_extension_fields_data_extension_id_name_key" ON "salesforce_data_extension_fields"("data_extension_id", "name");

-- CreateIndex
CREATE INDEX "salesforce_data_extension_rows_dataset_id_primary_key_idx" ON "salesforce_data_extension_rows"("dataset_id", "primary_key");

-- CreateIndex
CREATE INDEX "salesforce_data_extension_rows_dataset_id_row_hash_idx" ON "salesforce_data_extension_rows"("dataset_id", "row_hash");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_data_extension_rows_dataset_id_page_no_row_no_key" ON "salesforce_data_extension_rows"("dataset_id", "page_no", "row_no");

-- CreateIndex
CREATE INDEX "salesforce_subscribers_subscriber_key_idx" ON "salesforce_subscribers"("subscriber_key");

-- CreateIndex
CREATE INDEX "salesforce_subscribers_email_address_idx" ON "salesforce_subscribers"("email_address");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_subscribers_dataset_id_page_no_row_no_key" ON "salesforce_subscribers"("dataset_id", "page_no", "row_no");

-- CreateIndex
CREATE INDEX "salesforce_email_jobs_mid_job_id_idx" ON "salesforce_email_jobs"("mid", "job_id");

-- CreateIndex
CREATE INDEX "salesforce_email_jobs_email_id_idx" ON "salesforce_email_jobs"("email_id");

-- CreateIndex
CREATE INDEX "salesforce_email_jobs_sent_date_idx" ON "salesforce_email_jobs"("sent_date");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_email_jobs_connection_id_mid_job_id_key" ON "salesforce_email_jobs"("connection_id", "mid", "job_id");

-- CreateIndex
CREATE INDEX "salesforce_tracking_events_mid_job_id_event_type_idx" ON "salesforce_tracking_events"("mid", "job_id", "event_type");

-- CreateIndex
CREATE INDEX "salesforce_tracking_events_subscriber_key_idx" ON "salesforce_tracking_events"("subscriber_key");

-- CreateIndex
CREATE INDEX "salesforce_tracking_events_event_date_idx" ON "salesforce_tracking_events"("event_date");

-- CreateIndex
CREATE INDEX "salesforce_tracking_events_dataset_id_fingerprint_idx" ON "salesforce_tracking_events"("dataset_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_tracking_events_dataset_id_page_no_row_no_key" ON "salesforce_tracking_events"("dataset_id", "page_no", "row_no");

-- CreateIndex
CREATE INDEX "salesforce_assets_name_idx" ON "salesforce_assets"("name");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_assets_connection_id_mid_asset_id_key" ON "salesforce_assets"("connection_id", "mid", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_journeys_connection_id_mid_journey_id_version_key" ON "salesforce_journeys"("connection_id", "mid", "journey_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_automations_connection_id_mid_kind_object_id_key" ON "salesforce_automations"("connection_id", "mid", "kind", "object_id");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_reconciliation_jobs_code_key" ON "salesforce_reconciliation_jobs"("code");

-- CreateIndex
CREATE INDEX "salesforce_reconciliation_jobs_mid_created_at_idx" ON "salesforce_reconciliation_jobs"("mid", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_reconciliation_results_reconciliation_id_classif_idx" ON "salesforce_reconciliation_results"("reconciliation_id", "classification");

-- CreateIndex
CREATE INDEX "salesforce_reconciliation_results_reconciliation_id_identit_idx" ON "salesforce_reconciliation_results"("reconciliation_id", "identity");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_evidence_packages_code_key" ON "salesforce_evidence_packages"("code");

-- CreateIndex
CREATE INDEX "salesforce_evidence_packages_kind_created_at_idx" ON "salesforce_evidence_packages"("kind", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_extraction_errors_backup_job_id_idx" ON "salesforce_extraction_errors"("backup_job_id");

-- CreateIndex
CREATE INDEX "salesforce_extraction_errors_dataset_id_idx" ON "salesforce_extraction_errors"("dataset_id");

-- CreateIndex
CREATE INDEX "salesforce_extraction_errors_created_at_idx" ON "salesforce_extraction_errors"("created_at");

-- CreateIndex
CREATE INDEX "salesforce_extraction_logs_backup_job_id_created_at_idx" ON "salesforce_extraction_logs"("backup_job_id", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_extraction_logs_dataset_id_created_at_idx" ON "salesforce_extraction_logs"("dataset_id", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_archive_audit_logs_entity_type_entity_id_idx" ON "salesforce_archive_audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "salesforce_archive_audit_logs_actor_id_created_at_idx" ON "salesforce_archive_audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "salesforce_archive_audit_logs_created_at_idx" ON "salesforce_archive_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "salesforce_business_units" ADD CONSTRAINT "salesforce_business_units_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "salesforce_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_backup_jobs" ADD CONSTRAINT "salesforce_backup_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "salesforce_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_backup_schedules" ADD CONSTRAINT "salesforce_backup_schedules_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "salesforce_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_backup_datasets" ADD CONSTRAINT "salesforce_backup_datasets_backup_job_id_fkey" FOREIGN KEY ("backup_job_id") REFERENCES "salesforce_backup_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_backup_pages" ADD CONSTRAINT "salesforce_backup_pages_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "salesforce_backup_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_data_extension_fields" ADD CONSTRAINT "salesforce_data_extension_fields_data_extension_id_fkey" FOREIGN KEY ("data_extension_id") REFERENCES "salesforce_data_extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesforce_reconciliation_results" ADD CONSTRAINT "salesforce_reconciliation_results_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "salesforce_reconciliation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
