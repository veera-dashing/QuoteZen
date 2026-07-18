-- AlterTable
ALTER TABLE "quote_lcd_screens" ADD COLUMN     "brightness_nits" INTEGER,
ADD COLUMN     "duty_cycle" TEXT,
ADD COLUMN     "preferred_brand" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "account_exec" TEXT,
ADD COLUMN     "space_around_screen_mm" INTEGER;
