-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "discount_pct" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "led_products" ADD COLUMN     "manufacturer_id" BIGINT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "discount_pct" DECIMAL(5,4),
ADD COLUMN     "project_notes" TEXT,
ADD COLUMN     "site_address" TEXT;

-- CreateTable
CREATE TABLE "manufacturers" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "lead_time_days" INTEGER,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manufacturers_name_key" ON "manufacturers"("name");

-- AddForeignKey
ALTER TABLE "led_products" ADD CONSTRAINT "led_products_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

