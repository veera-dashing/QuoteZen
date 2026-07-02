-- AlterTable
ALTER TABLE "display_catalog" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "built_in_android" BOOLEAN,
ADD COLUMN     "depth_mm" INTEGER,
ADD COLUMN     "max_size_in" INTEGER,
ADD COLUMN     "min_size_in" INTEGER,
ADD COLUMN     "portrait_capable" BOOLEAN;

-- AlterTable
ALTER TABLE "quote_lcd_screens" ADD COLUMN     "max_depth_mm" INTEGER,
ADD COLUMN     "needs_hard_drive" BOOLEAN,
ADD COLUMN     "needs_pc" BOOLEAN,
ADD COLUMN     "requires_android" BOOLEAN;
