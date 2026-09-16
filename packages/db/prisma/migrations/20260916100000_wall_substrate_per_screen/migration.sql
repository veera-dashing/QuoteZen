-- Wall substrate moves from the quote to the individual screen.
--
-- Substrate drives the fixing method, and screens in one job routinely land on different materials:
-- a plasterboard partition and a brick facade in the same building. A single quote-level value could
-- not describe both. Follows the same move made for sun_exposure.

-- 1. Add the per-screen columns (nullable — absence means "not captured", as before).
ALTER TABLE "quote_led_screens" ADD COLUMN "wall_substrate" TEXT;
ALTER TABLE "quote_lcd_screens" ADD COLUMN "wall_substrate" TEXT;

-- 2. Backfill: every existing screen inherits its quote's value, so no captured answer is lost.
--    Screens on quotes that never recorded one stay NULL.
UPDATE "quote_led_screens" s
   SET "wall_substrate" = q."wall_substrate"
  FROM "quotes" q
 WHERE q."id" = s."quote_id"
   AND q."wall_substrate" IS NOT NULL;

UPDATE "quote_lcd_screens" s
   SET "wall_substrate" = q."wall_substrate"
  FROM "quotes" q
 WHERE q."id" = s."quote_id"
   AND q."wall_substrate" IS NOT NULL;

-- 3. Drop the quote-level column now that its data has been carried down.
ALTER TABLE "quotes" DROP COLUMN "wall_substrate";
