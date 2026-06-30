-- CreateTable
CREATE TABLE "quote_documents" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_documents_quote_id_idx" ON "quote_documents"("quote_id");

-- AddForeignKey
ALTER TABLE "quote_documents" ADD CONSTRAINT "quote_documents_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_documents" ADD CONSTRAINT "quote_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

