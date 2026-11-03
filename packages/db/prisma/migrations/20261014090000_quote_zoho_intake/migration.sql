-- Phase 2: Zoho intake + AI extraction. Additive and nullable: existing quotes keep NULL and
-- Phase 1 code ignores both columns.
-- zoho_deal_id: the Zoho CRM deal a quote was created from (unique → one deal, one quote).
-- ai_intake: the AI's proposed intake values, kept for estimator review.

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "ai_intake" JSONB,
ADD COLUMN     "zoho_deal_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "quotes_zoho_deal_id_key" ON "quotes"("zoho_deal_id");
