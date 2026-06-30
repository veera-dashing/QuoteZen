-- AlterTable
ALTER TABLE "quote_lcd_screens" ADD COLUMN     "orientation" TEXT;

-- AlterTable
ALTER TABLE "quote_led_screens" ADD COLUMN     "aspect_ratio_id" BIGINT,
ADD COLUMN     "back_cover" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "frame_note" TEXT,
ADD COLUMN     "orientation" TEXT,
ADD COLUMN     "service_description_suffix" TEXT;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_aspect_ratio_id_fkey" FOREIGN KEY ("aspect_ratio_id") REFERENCES "screen_ratios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

