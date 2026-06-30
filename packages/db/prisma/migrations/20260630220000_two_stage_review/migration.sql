-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "QuoteStatus" ADD VALUE 'technical_review';
ALTER TYPE "QuoteStatus" ADD VALUE 'commercial_review';

-- CreateTable
CREATE TABLE "quote_reviews" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "lock_version" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewer_id" BIGINT NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_reviews_quote_id_idx" ON "quote_reviews"("quote_id");

-- AddForeignKey
ALTER TABLE "quote_reviews" ADD CONSTRAINT "quote_reviews_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_reviews" ADD CONSTRAINT "quote_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

