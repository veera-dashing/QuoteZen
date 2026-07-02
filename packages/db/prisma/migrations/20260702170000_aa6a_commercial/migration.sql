-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "typical_selection_note" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "budget_aud" DECIMAL(12,2),
ADD COLUMN     "client_must_haves" TEXT,
ADD COLUMN     "needs_solutions_engineer" BOOLEAN,
ADD COLUMN     "price_sensitivity" TEXT,
ADD COLUMN     "tenure_months" INTEGER;

