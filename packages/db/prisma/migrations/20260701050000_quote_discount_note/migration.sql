-- Quote-level discount guardrail: manager justification note (required above the note threshold).
ALTER TABLE "quotes" ADD COLUMN     "discount_note" TEXT;
