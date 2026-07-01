-- Z1: engine constraints & systemic rules — foundation.
-- Additive & backward-compatible: nullable clients.tier + new anomaly_rules table.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "tier" TEXT;

-- CreateTable
CREATE TABLE "anomaly_rules" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" TEXT NOT NULL DEFAULT 'warn',
    "param_num" DECIMAL(12,2),
    "param_text" TEXT,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "anomaly_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_rules_key_key" ON "anomaly_rules"("key");
