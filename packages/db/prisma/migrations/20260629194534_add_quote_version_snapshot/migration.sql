-- AlterTable
ALTER TABLE "quote_revisions" ADD COLUMN     "grand_total" DECIMAL(12,2),
ADD COLUMN     "restored_from" INTEGER,
ADD COLUMN     "snapshot" JSONB;

