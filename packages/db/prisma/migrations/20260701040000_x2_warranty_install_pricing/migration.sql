-- AlterTable
ALTER TABLE "install_methods" ADD COLUMN     "default_hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hourly_rate_cost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "warranty_options" ADD COLUMN     "per_year_cost" DECIMAL(12,2) NOT NULL DEFAULT 0;

