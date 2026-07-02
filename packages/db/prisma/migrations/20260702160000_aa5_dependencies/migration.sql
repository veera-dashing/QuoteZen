-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "custom_content_curation" BOOLEAN,
ADD COLUMN     "hard_drive_required" BOOLEAN,
ADD COLUMN     "media_player_supply" TEXT,
ADD COLUMN     "pc_required" BOOLEAN,
ADD COLUMN     "shared_device_players" INTEGER,
ADD COLUMN     "shared_device_screens" INTEGER,
ADD COLUMN     "store_size_sqm" DECIMAL(10,2);
