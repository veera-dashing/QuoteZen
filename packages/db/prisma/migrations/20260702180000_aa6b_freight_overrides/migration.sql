-- CreateTable
CREATE TABLE "freight_overrides" (
    "id" BIGSERIAL NOT NULL,
    "location_id" BIGINT,
    "manufacturer_id" BIGINT,
    "rate_per_screen_aud" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "freight_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "freight_overrides_location_id_idx" ON "freight_overrides"("location_id");

-- CreateIndex
CREATE INDEX "freight_overrides_manufacturer_id_idx" ON "freight_overrides"("manufacturer_id");

-- AddForeignKey
ALTER TABLE "freight_overrides" ADD CONSTRAINT "freight_overrides_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_overrides" ADD CONSTRAINT "freight_overrides_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
