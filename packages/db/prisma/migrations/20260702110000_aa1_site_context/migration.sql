-- AlterTable
ALTER TABLE "quote_lcd_screens" ADD COLUMN     "recess_depth_mm" INTEGER;

-- AlterTable
ALTER TABLE "quote_led_screens" ADD COLUMN     "recess_depth_mm" INTEGER;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "airside_landside" TEXT,
ADD COLUMN     "controller_location" TEXT,
ADD COLUMN     "end_customer" TEXT,
ADD COLUMN     "power_data_available" TEXT,
ADD COLUMN     "sun_exposure" TEXT,
ADD COLUMN     "wall_substrate" TEXT,
ADD COLUMN     "window_facing" BOOLEAN;

