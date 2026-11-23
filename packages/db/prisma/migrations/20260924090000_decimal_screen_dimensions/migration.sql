-- Sub-millimetre screen dimensions.
--
-- Cabinet/module sizes and the requested opening were INTEGER, but real panels are not whole
-- millimetres: 15 LED products have a 337.5mm cabinet (module 168.75mm), which was stored as 338.
-- A screen is built from whole cabinets, so that half-millimetre multiplied by the cabinet count --
-- 6 cabinets high was reported as 2028mm when the panel actually makes exactly 2025mm, and flagged
-- "+0.1% over" on an opening it fits perfectly. The error also feeds area, and area drives the LED
-- supply price per m².
--
-- Widening INT -> DECIMAL is lossless; existing whole-millimetre values are unchanged.
ALTER TABLE "led_products"
  ALTER COLUMN "module_w_mm"       TYPE DECIMAL(10,2),
  ALTER COLUMN "module_h_mm"       TYPE DECIMAL(10,2),
  ALTER COLUMN "min_cabinet_w_mm"  TYPE DECIMAL(10,2),
  ALTER COLUMN "min_cabinet_h_mm"  TYPE DECIMAL(10,2);

ALTER TABLE "quote_led_screens"
  ALTER COLUMN "desired_width_mm"  TYPE DECIMAL(10,2),
  ALTER COLUMN "desired_height_mm" TYPE DECIMAL(10,2);

-- Restore the precision that was truncated on import. Matched on the ROUNDED value so this only
-- touches rows still carrying the lossy figure, and is safe to re-run.
UPDATE "led_products" SET "min_cabinet_h_mm" = 337.50 WHERE "min_cabinet_h_mm" = 338;
UPDATE "led_products" SET "module_h_mm"      = 168.75 WHERE "module_h_mm"      = 169;
