-- CreateTable
CREATE TABLE "quote_risks" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "mitigation" TEXT,
    "seq" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_risks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_risks_quote_id_idx" ON "quote_risks"("quote_id");

-- AddForeignKey
ALTER TABLE "quote_risks" ADD CONSTRAINT "quote_risks_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

