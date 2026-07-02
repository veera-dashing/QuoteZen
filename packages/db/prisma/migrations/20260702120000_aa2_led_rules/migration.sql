-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "allowed_ratios" TEXT;

-- AlterTable
ALTER TABLE "controllers" ADD COLUMN     "compatibility_group" TEXT;

-- AlterTable
ALTER TABLE "frames" ADD COLUMN     "compatibility_group" TEXT;

-- AlterTable
ALTER TABLE "led_products" ADD COLUMN     "compatibility_group" TEXT;

-- AlterTable
ALTER TABLE "quote_led_screens" ADD COLUMN     "content_ratio" TEXT,
ADD COLUMN     "content_supplier" TEXT,
ADD COLUMN     "flatness_required" BOOLEAN;

