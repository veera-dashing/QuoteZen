-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "value_text" TEXT,
ALTER COLUMN "value" DROP NOT NULL;

