-- CreateTable
CREATE TABLE "kb_entries" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "job_reference" TEXT NOT NULL,
    "client_name" TEXT,
    "location_name" TEXT,
    "screen_count" INTEGER NOT NULL,
    "product_models" TEXT,
    "grand_total" DECIMAL(12,2) NOT NULL,
    "margin" DECIMAL(8,4),
    "outcome" TEXT NOT NULL,
    "captured_by" BIGINT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_entries_quote_id_key" ON "kb_entries"("quote_id");

-- CreateIndex
CREATE INDEX "kb_entries_outcome_idx" ON "kb_entries"("outcome");

-- AddForeignKey
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_captured_by_fkey" FOREIGN KEY ("captured_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

