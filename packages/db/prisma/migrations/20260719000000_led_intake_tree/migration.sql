-- AlterTable
ALTER TABLE "led_products" ADD COLUMN IF NOT EXISTS "is_transparent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "supports_curved" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote_led_screens" ADD COLUMN IF NOT EXISTS "intake_answers" JSONB;

-- Backfill is_transparent based on cabinet_type
UPDATE "led_products" SET "is_transparent" = true WHERE "cabinet_type" ILIKE '%transparent%';

-- Backfill supports_curved based on mechanical_options or model
UPDATE "led_products" SET "supports_curved" = true WHERE "mechanical_options" ILIKE '%curve%' OR "model" ILIKE '%flex%';
