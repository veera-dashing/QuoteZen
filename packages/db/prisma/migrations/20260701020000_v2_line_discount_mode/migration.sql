-- AlterTable
ALTER TABLE "quote_lcd_items" ADD COLUMN     "discount_pct" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "quote_led_cost_breakdown" ADD COLUMN     "discount_pct" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "discount_mode" TEXT NOT NULL DEFAULT 'stack';

