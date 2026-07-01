-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "preferred_freight" TEXT,
ADD COLUMN     "rules_note" TEXT;

-- CreateTable
CREATE TABLE "client_tiers" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "description" TEXT,
    "install_standard" TEXT,
    "preferred_freight" TEXT,
    "default_discount_pct" DECIMAL(5,4),
    "deprecated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "client_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_tiers_name_key" ON "client_tiers"("name");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tier_fkey" FOREIGN KEY ("tier") REFERENCES "client_tiers"("name") ON DELETE SET NULL ON UPDATE CASCADE;
