-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "excluded_components" TEXT,
ADD COLUMN     "preferred_pitch_mm" DECIMAL(6,3),
ADD COLUMN     "preferred_product_family" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "lock_version" INTEGER NOT NULL DEFAULT 0;

