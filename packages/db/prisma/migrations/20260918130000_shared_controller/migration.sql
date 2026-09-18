-- Multiple screens of the same type driven by ONE controller.
--
-- A screen row carries a qty, and the quote rollup multiplies the row's whole sell by that qty --
-- so a controller attached to a Qty-5 row is currently charged five times. With this flag set the
-- controller is charged once for the row instead.
--
-- NOT NULL with a false default, so every existing screen keeps charging a controller per unit.
ALTER TABLE "quote_led_screens" ADD COLUMN "shared_controller" BOOLEAN NOT NULL DEFAULT false;
