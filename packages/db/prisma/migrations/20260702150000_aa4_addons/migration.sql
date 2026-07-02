-- CreateTable
CREATE TABLE "coating_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cost_per_sqm" DECIMAL(12,2) NOT NULL,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "coating_options_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "quote_led_screens" ADD COLUMN     "coating_id" BIGINT,
ADD COLUMN     "high_resolution" BOOLEAN;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_coating_id_fkey" FOREIGN KEY ("coating_id") REFERENCES "coating_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
