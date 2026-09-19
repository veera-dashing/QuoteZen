-- Explicit Chip-on-Board flag on LED products.
--
-- COB panels have their LED dice bonded to the board and flood-coated in resin, so the face is
-- already sealed and a separate protective coating is redundant. Until now COB could only be
-- inferred from the free-text model name, which is fragile: a renamed or newly imported product
-- would silently stop being recognised. An explicit column puts it in the admin catalogue instead.
ALTER TABLE "led_products" ADD COLUMN "is_cob" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the existing naming convention -- every current COB product carries "COB" in its
-- model (16 rows, verified to contain no false positives such as "Cobalt"). This runs ONCE; from
-- here the flag is maintained by admins in Reference data -> LED Products.
UPDATE "led_products" SET "is_cob" = true WHERE "model" ILIKE '%cob%';
