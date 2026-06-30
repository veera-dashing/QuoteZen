-- CreateTable
CREATE TABLE "quote_overrides" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" BIGINT,
    "field_name" TEXT NOT NULL,
    "original_value" DECIMAL(12,2) NOT NULL,
    "override_value" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_overrides_quote_id_idx" ON "quote_overrides"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_overrides_quote_id_target_type_target_id_field_name_key" ON "quote_overrides"("quote_id", "target_type", "target_id", "field_name");

-- AddForeignKey
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

