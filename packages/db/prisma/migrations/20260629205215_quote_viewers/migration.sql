-- CreateTable
CREATE TABLE "quote_viewers" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_viewers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_viewers_user_id_idx" ON "quote_viewers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_viewers_quote_id_user_id_key" ON "quote_viewers"("quote_id", "user_id");

-- AddForeignKey
ALTER TABLE "quote_viewers" ADD CONSTRAINT "quote_viewers_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_viewers" ADD CONSTRAINT "quote_viewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

