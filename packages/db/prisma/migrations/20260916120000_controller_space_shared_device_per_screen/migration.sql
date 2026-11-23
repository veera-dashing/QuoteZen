-- Controller location, space-around-screen, and the shared-device ratio move from the quote to the
-- individual screen. Follows the same move already made for sun_exposure and wall_substrate.
--
-- Each is a property of a screen's position, not of the job: a job can put one controller in a comms
-- room and another behind the screen, and clearance differs wall by wall.

-- 1. Add the per-screen columns (nullable — absence means "not captured", as before).
ALTER TABLE "quote_led_screens"
  ADD COLUMN "controller_location"   TEXT,
  ADD COLUMN "space_around_screen_mm" INTEGER,
  ADD COLUMN "shared_device_players"  INTEGER,
  ADD COLUMN "shared_device_screens"  INTEGER;

ALTER TABLE "quote_lcd_screens"
  ADD COLUMN "controller_location"   TEXT,
  ADD COLUMN "space_around_screen_mm" INTEGER,
  ADD COLUMN "shared_device_players"  INTEGER,
  ADD COLUMN "shared_device_screens"  INTEGER;

-- 2. Backfill: every existing screen inherits its quote's values, so no captured answer is lost.
--    Screens on quotes that never recorded one stay NULL.
UPDATE "quote_led_screens" s
   SET "controller_location"    = q."controller_location",
       "space_around_screen_mm" = q."space_around_screen_mm",
       "shared_device_players"  = q."shared_device_players",
       "shared_device_screens"  = q."shared_device_screens"
  FROM "quotes" q
 WHERE q."id" = s."quote_id";

UPDATE "quote_lcd_screens" s
   SET "controller_location"    = q."controller_location",
       "space_around_screen_mm" = q."space_around_screen_mm",
       "shared_device_players"  = q."shared_device_players",
       "shared_device_screens"  = q."shared_device_screens"
  FROM "quotes" q
 WHERE q."id" = s."quote_id";

-- 3. Drop the quote-level columns now that their data has been carried down.
ALTER TABLE "quotes"
  DROP COLUMN "controller_location",
  DROP COLUMN "space_around_screen_mm",
  DROP COLUMN "shared_device_players",
  DROP COLUMN "shared_device_screens";
