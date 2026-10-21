-- DropIndex
DROP INDEX "salesforce_data_extension_rows_values_gin";

-- DropIndex
DROP INDEX "salesforce_tracking_events_event_date_brin";

-- AlterTable
ALTER TABLE "salesforce_backup_jobs" ADD COLUMN     "lease_until" TIMESTAMP(3),
ADD COLUMN     "step_count" INTEGER NOT NULL DEFAULT 0;
