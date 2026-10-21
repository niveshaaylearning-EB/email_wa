-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "review_decisions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "test_send_count" INTEGER NOT NULL DEFAULT 0;
