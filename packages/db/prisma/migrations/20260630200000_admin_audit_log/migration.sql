-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "table_name" TEXT NOT NULL,
    "record_id" TEXT,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_log_table_name_idx" ON "admin_audit_log"("table_name");

-- CreateIndex
CREATE INDEX "admin_audit_log_changed_at_idx" ON "admin_audit_log"("changed_at");

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

