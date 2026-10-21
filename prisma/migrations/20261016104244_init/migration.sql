-- CreateEnum
CREATE TYPE "RoleKey" AS ENUM ('ADMIN', 'CAMPAIGN_CREATOR', 'APPROVER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "ChannelMode" AS ENUM ('EMAIL', 'WHATSAPP', 'BOTH');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('ZOHO_CRM', 'ZOHO_MA', 'DOUBLETICK');

-- CreateEnum
CREATE TYPE "ProviderMode" AS ENUM ('MOCK', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "MembershipSource" AS ENUM ('MANUAL', 'BULK', 'CSV', 'RULE');

-- CreateEnum
CREATE TYPE "MembershipAction" AS ENUM ('ADDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "TemplateApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CampaignPurpose" AS ENUM ('RESEARCH_UPDATE', 'PORTFOLIO_ADVISORY', 'SERVICE_NOTICE', 'EVENT_INVITATION', 'REGULATORY_DISCLOSURE', 'MARKETING', 'OTHER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'APPROVED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "OverlapStrategy" AS ENUM ('PRIORITY', 'PER_CATEGORY', 'EXCLUDE_CONFLICTS', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('ELIGIBLE', 'EXCLUDED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ExclusionReason" AS ENUM ('MISSING_EMAIL', 'MISSING_PHONE', 'INVALID_EMAIL', 'INVALID_PHONE', 'UNSUBSCRIBED', 'NO_CONSENT', 'SUPPRESSED', 'CRM_OPT_OUT', 'CONFLICT_EXCLUDED', 'CONFLICT_UNRESOLVED', 'CLIENT_INACTIVE', 'DUPLICATE_IDENTITY', 'MISSING_TEMPLATE_DATA');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PLANNED', 'NEEDS_REVIEW', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'QUEUED', 'SUBMITTED', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'CANCELLED', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "DeliveryEventSource" AS ENUM ('SYSTEM', 'API_RESPONSE', 'WEBHOOK', 'REPORT_RECONCILIATION', 'SIMULATION');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('CRM', 'MANUAL', 'CSV', 'PROVIDER_UNSUBSCRIBE', 'CLIENT_REQUEST');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT', 'MANUAL', 'DND', 'INVALID_CONTACT', 'LEGAL_HOLD');

-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "SyncType" AS ENUM ('INITIAL', 'INCREMENTAL', 'MANUAL', 'DELETED_RECORDS', 'RULE_EVALUATION', 'PROVIDER_REPORT', 'AUDIENCE_SYNC');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'IGNORED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" "RoleKey" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "zoho_crm_id" TEXT NOT NULL,
    "crm_module" TEXT NOT NULL DEFAULT 'Contacts',
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "email_normalized" TEXT,
    "secondary_email" TEXT,
    "phone_raw" TEXT,
    "phone_e164" TEXT,
    "phone_country" TEXT,
    "phone_country_code" TEXT,
    "phone_valid" BOOLEAN NOT NULL DEFAULT false,
    "crm_status" TEXT,
    "crm_owner" TEXT,
    "city" TEXT,
    "crm_email_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "crm_fields" JSONB NOT NULL DEFAULT '{}',
    "crm_modified_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "deleted_in_crm_at" TIMESTAMP(3),
    "duplicate_of_id" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#1F4E79',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_by_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_categories" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "source" "MembershipSource" NOT NULL,
    "rule_id" TEXT,
    "added_by_id" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "removed_by_id" TEXT,

    CONSTRAINT "client_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "action" "MembershipAction" NOT NULL,
    "source" "MembershipSource" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_rules" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "auto_remove" BOOLEAN NOT NULL DEFAULT false,
    "last_evaluated_at" TIMESTAMP(3),
    "last_match_count" INTEGER,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "category_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" "Provider" NOT NULL,
    "provider_template_id" TEXT,
    "language" TEXT,
    "subject" TEXT,
    "sender_name" TEXT,
    "body" TEXT NOT NULL,
    "header" JSONB,
    "buttons" JSONB,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "approval_status" "TemplateApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "change_note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_templates" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "category_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "purpose" "CampaignPurpose" NOT NULL,
    "channel_mode" "ChannelMode" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "overlap_strategy" "OverlapStrategy" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "scheduled_at" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 60,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "approval_note" TEXT,
    "rejected_by_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "live_confirmed_at" TIMESTAMP(3),
    "queued_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" TEXT,
    "failure_reason" TEXT,
    "provider_refs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_categories" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "email_template_id" TEXT,
    "whatsapp_template_id" TEXT,
    "member_count_at_snapshot" INTEGER,

    CONSTRAINT "campaign_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_snapshots" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozen_by_id" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "categories" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,

    CONSTRAINT "campaign_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL,
    "exclusion_reasons" "ExclusionReason"[],
    "matched_category_ids" TEXT[],
    "contact_snapshot" JSONB NOT NULL,
    "consent_decision" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_message_assignments" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "category_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version_id" TEXT,
    "status" "AssignmentStatus" NOT NULL,
    "rendered" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_message_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "provider" "Provider" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "is_simulated" BOOLEAN NOT NULL DEFAULT false,
    "is_dry_run" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "source" "DeliveryEventSource" NOT NULL,
    "from_status" "DeliveryStatus",
    "to_status" "DeliveryStatus" NOT NULL,
    "detail" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'communications',
    "evidence" TEXT,
    "recorded_by_id" TEXT,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" TEXT NOT NULL,
    "channel" "Channel",
    "identifier_type" "IdentifierType" NOT NULL,
    "identifier_value" TEXT NOT NULL,
    "client_id" TEXT,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMP(3),
    "lifted_by_id" TEXT,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_test_recipients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone_e164" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_test_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_settings" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "mode" "ProviderMode" NOT NULL DEFAULT 'MOCK',
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets_encrypted" TEXT,
    "secrets_hint" JSONB NOT NULL DEFAULT '{}',
    "account_info" JSONB NOT NULL DEFAULT '{}',
    "api_usage" JSONB NOT NULL DEFAULT '{}',
    "last_success_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "type" "SyncType" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "triggered_by_id" TEXT,
    "cursor" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "api_calls" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "headers" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "campaign_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "clients_zoho_crm_id_key" ON "clients"("zoho_crm_id");

-- CreateIndex
CREATE INDEX "clients_email_normalized_idx" ON "clients"("email_normalized");

-- CreateIndex
CREATE INDEX "clients_phone_e164_idx" ON "clients"("phone_e164");

-- CreateIndex
CREATE INDEX "clients_full_name_idx" ON "clients"("full_name");

-- CreateIndex
CREATE INDEX "clients_crm_modified_at_idx" ON "clients"("crm_modified_at");

-- CreateIndex
CREATE INDEX "clients_duplicate_of_id_idx" ON "clients"("duplicate_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_archived_at_idx" ON "categories"("archived_at");

-- CreateIndex
CREATE INDEX "client_categories_category_id_removed_at_idx" ON "client_categories"("category_id", "removed_at");

-- CreateIndex
CREATE INDEX "client_categories_client_id_removed_at_idx" ON "client_categories"("client_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_categories_client_id_category_id_key" ON "client_categories"("client_id", "category_id");

-- CreateIndex
CREATE INDEX "membership_events_category_id_created_at_idx" ON "membership_events"("category_id", "created_at");

-- CreateIndex
CREATE INDEX "membership_events_client_id_created_at_idx" ON "membership_events"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "category_rules_category_id_idx" ON "category_rules"("category_id");

-- CreateIndex
CREATE INDEX "templates_channel_approval_status_idx" ON "templates"("channel", "approval_status");

-- CreateIndex
CREATE UNIQUE INDEX "templates_channel_name_key" ON "templates"("channel", "name");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_key" ON "template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "category_templates_template_id_idx" ON "category_templates"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_templates_category_id_template_id_key" ON "category_templates"("category_id", "template_id");

-- CreateIndex
CREATE INDEX "campaigns_status_scheduled_at_idx" ON "campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "campaigns_created_at_idx" ON "campaigns"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_categories_campaign_id_category_id_key" ON "campaign_categories"("campaign_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_categories_campaign_id_priority_key" ON "campaign_categories"("campaign_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_snapshots_campaign_id_key" ON "campaign_snapshots"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_status_idx" ON "campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_client_id_key" ON "campaign_recipients"("campaign_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_message_assignments_idempotency_key_key" ON "campaign_message_assignments"("idempotency_key");

-- CreateIndex
CREATE INDEX "campaign_message_assignments_campaign_id_status_idx" ON "campaign_message_assignments"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_message_assignments_campaign_id_recipient_id_chann_key" ON "campaign_message_assignments"("campaign_id", "recipient_id", "channel", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_assignment_id_key" ON "message_deliveries"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_deliveries_provider_message_id_key" ON "message_deliveries"("provider_message_id");

-- CreateIndex
CREATE INDEX "message_deliveries_campaign_id_status_idx" ON "message_deliveries"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "message_deliveries_client_id_created_at_idx" ON "message_deliveries"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "message_deliveries_status_next_attempt_at_idx" ON "message_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "delivery_events_delivery_id_occurred_at_idx" ON "delivery_events"("delivery_id", "occurred_at");

-- CreateIndex
CREATE INDEX "consents_client_id_channel_effective_at_idx" ON "consents"("client_id", "channel", "effective_at");

-- CreateIndex
CREATE INDEX "suppression_entries_identifier_type_identifier_value_lifted_idx" ON "suppression_entries"("identifier_type", "identifier_value", "lifted_at");

-- CreateIndex
CREATE INDEX "suppression_entries_client_id_idx" ON "suppression_entries"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_settings_provider_key" ON "integration_settings"("provider");

-- CreateIndex
CREATE INDEX "sync_runs_provider_started_at_idx" ON "sync_runs"("provider", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_events_provider_received_at_idx" ON "webhook_events"("provider", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_campaign_id_created_at_idx" ON "audit_logs"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_categories" ADD CONSTRAINT "client_categories_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_categories" ADD CONSTRAINT "client_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_categories" ADD CONSTRAINT "client_categories_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "category_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_templates" ADD CONSTRAINT "category_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_templates" ADD CONSTRAINT "category_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_categories" ADD CONSTRAINT "campaign_categories_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_categories" ADD CONSTRAINT "campaign_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_snapshots" ADD CONSTRAINT "campaign_snapshots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_message_assignments" ADD CONSTRAINT "campaign_message_assignments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_message_assignments" ADD CONSTRAINT "campaign_message_assignments_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_message_assignments" ADD CONSTRAINT "campaign_message_assignments_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_message_assignments" ADD CONSTRAINT "campaign_message_assignments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_message_assignments" ADD CONSTRAINT "campaign_message_assignments_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "campaign_message_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "message_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
