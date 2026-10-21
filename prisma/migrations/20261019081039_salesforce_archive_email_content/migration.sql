-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SfDatasetKind" ADD VALUE 'EMAILS';
ALTER TYPE "SfDatasetKind" ADD VALUE 'CONTENT_FILES';

-- CreateTable
CREATE TABLE "salesforce_emails" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "email_id" TEXT NOT NULL,
    "name" TEXT,
    "subject" TEXT,
    "preheader" TEXT,
    "email_type" TEXT,
    "created_date" TEXT,
    "modified_date" TEXT,
    "modified_at" TIMESTAMP(3),
    "html_storage_key" TEXT,
    "html_sha256" TEXT,
    "html_bytes" INTEGER,
    "text_storage_key" TEXT,
    "text_sha256" TEXT,
    "references" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "dataset_id" TEXT NOT NULL,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesforce_content_files" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "asset_id" TEXT,
    "storage_key" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "content_type" TEXT,
    "http_status" INTEGER,
    "error" TEXT,
    "dataset_id" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salesforce_content_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_emails_connection_id_mid_email_id_key" ON "salesforce_emails"("connection_id", "mid", "email_id");

-- CreateIndex
CREATE UNIQUE INDEX "salesforce_content_files_connection_id_url_key" ON "salesforce_content_files"("connection_id", "url");
