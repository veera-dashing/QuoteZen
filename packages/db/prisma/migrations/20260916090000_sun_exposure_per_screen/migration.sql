-- Sun exposure moves from the quote to the individual screen.
--
-- One site routinely holds screens with different exposure: a shaded interior wall and a
-- west-facing window in the same job. A single quote-level value could not describe both, so the
-- field now lives on each LED and LCD screen. It stays descriptive — it feeds the PM handoff and
-- product-selection judgement, and touches no pricing or validation path.

-- 1. Add the per-screen columns (nullable — absence means "not captured", as before).
ALTER TABLE "quote_led_screens" ADD COLUMN "sun_exposure" TEXT;
ALTER TABLE "quote_lcd_screens" ADD COLUMN "sun_exposure" TEXT;

-- 2. Backfill: every existing screen inherits its quote's value, so no captured answer is lost.
--    Screens on quotes that never recorded one stay NULL.
UPDATE "quote_led_screens" s
   SET "sun_exposure" = q."sun_exposure"
  FROM "quotes" q
 WHERE q."id" = s."quote_id"
   AND q."sun_exposure" IS NOT NULL;

UPDATE "quote_lcd_screens" s
   SET "sun_exposure" = q."sun_exposure"
  FROM "quotes" q
 WHERE q."id" = s."quote_id"
   AND q."sun_exposure" IS NOT NULL;

-- 3. Drop the quote-level column now that its data has been carried down.
ALTER TABLE "quotes" DROP COLUMN "sun_exposure";
