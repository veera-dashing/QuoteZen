-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'in_review', 'approved', 'issued', 'won', 'lost');

-- CreateEnum
CREATE TYPE "ScreenType" AS ENUM ('LED', 'LCD');

-- CreateEnum
CREATE TYPE "LicenceTier" AS ENUM ('low', 'high');

-- CreateEnum
CREATE TYPE "LedComponentType" AS ENUM ('controller', 'led_peripheral', 'mediaplayer', 'mediaplayer_peripheral');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete', 'status_change');

-- CreateEnum
CREATE TYPE "LcdItemType" AS ENUM ('display', 'mediaplayer', 'bracket', 'install', 'labour', 'location_fee');

-- CreateEnum
CREATE TYPE "HypervsnRateCard" AS ENUM ('aud', 'reseller_aud', 'nzd', 'reseller_nzd');

-- CreateTable
CREATE TABLE "roles" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entity_table" TEXT NOT NULL,
    "entity_id" BIGINT,
    "field_name" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_revisions" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "label" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" BIGSERIAL NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "pair_label" TEXT,
    "budget_rate" DECIMAL(12,6) NOT NULL,
    "live_rate" DECIMAL(12,6),

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" DECIMAL(12,6) NOT NULL,
    "unit" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seafreight_rates" (
    "id" BIGSERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "currency_id" BIGINT,

    CONSTRAINT "seafreight_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(12,2),

    CONSTRAINT "freight_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "freight_multiplier" DECIMAL(12,4) NOT NULL,
    "freight_min" DECIMAL(12,2) NOT NULL,
    "frame_freight" DECIMAL(12,2) NOT NULL,
    "trim_freight" DECIMAL(12,2) NOT NULL,
    "hourly_uplift" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "led_products" (
    "id" BIGSERIAL NOT NULL,
    "vendor" TEXT,
    "model" TEXT NOT NULL,
    "service_category" TEXT,
    "module_w_mm" INTEGER,
    "module_h_mm" INTEGER,
    "min_cabinet_w_mm" INTEGER,
    "min_cabinet_h_mm" INTEGER,
    "cabinet_depth_mm" INTEGER,
    "cabinet_type" TEXT,
    "pixel_pitch_h" DECIMAL(6,3),
    "pixel_pitch_v" DECIMAL(6,3),
    "brightness_nits" INTEGER,
    "power_max_w" INTEGER,
    "power_avg_w" INTEGER,
    "kg_per_sqm" DECIMAL(8,2),
    "ship_depth_mm" INTEGER,
    "volumetric_modifier" DECIMAL(6,3),
    "cost_per_sqm_usd" DECIMAL(12,2),
    "module_price" DECIMAL(12,2),
    "includes_receivers" BOOLEAN,
    "gob_included" BOOLEAN,
    "pack_included" BOOLEAN,
    "upgrade_options" TEXT,
    "mechanical_options" TEXT,
    "service_access" TEXT,
    "price_valid_from" TIMESTAMP(3),

    CONSTRAINT "led_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "led_commentary" (
    "id" BIGSERIAL NOT NULL,
    "service_category" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "commentary" TEXT NOT NULL,
    "led_product_id" BIGINT,

    CONSTRAINT "led_commentary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controllers" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "max_ports" INTEGER,
    "max_pixels" BIGINT,
    "max_width" INTEGER,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "controllers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "led_peripherals" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "led_peripherals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gob_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "gob_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trim_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "width_multiplier" DECIMAL(12,4) NOT NULL,
    "height_multiplier" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "trim_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hanging_bar_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "width_multiplier" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "hanging_bar_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frames" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "backcover_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "install_hours" DECIMAL(6,2) NOT NULL DEFAULT 0,

    CONSTRAINT "frames_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engineering_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "engineering_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "install_methods" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "wall_requirement" TEXT,
    "power_data_note" TEXT,

    CONSTRAINT "install_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_equipment" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "day_rate" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "access_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "years" INTEGER NOT NULL,

    CONSTRAINT "warranty_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_hours_options" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "service_hours_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_ratios" (
    "id" BIGSERIAL NOT NULL,
    "min_value" DECIMAL(8,2) NOT NULL,
    "max_value" DECIMAL(8,2) NOT NULL,
    "ratio_label" TEXT NOT NULL,

    CONSTRAINT "screen_ratios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mediaplayers" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "mediaplayers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "peripherals" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cost" DECIMAL(12,2) NOT NULL,
    "source_url" TEXT,

    CONSTRAINT "peripherals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "display_catalog" (
    "id" BIGSERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "size_inch" DECIMAL(6,1),
    "model" TEXT NOT NULL,
    "description" TEXT,
    "usd" DECIMAL(12,2),
    "list_aud" DECIMAL(12,2),
    "freight" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(12,2),
    "margin" DECIMAL(8,4),
    "sell" DECIMAL(12,2),

    CONSTRAINT "display_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_catalog" (
    "id" BIGSERIAL NOT NULL,
    "brand" TEXT NOT NULL,
    "series" TEXT,
    "size_inch" TEXT,
    "model" TEXT NOT NULL,
    "description" TEXT,
    "cost" DECIMAL(12,2),
    "sell" DECIMAL(12,2),
    "part_number" TEXT,

    CONSTRAINT "import_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufactured_products" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "size_inch" TEXT,
    "brightness" INTEGER,
    "cost" DECIMAL(12,2),
    "sell" DECIMAL(12,2),

    CONSTRAINT "manufactured_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufactured_components" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "manufactured_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufactured_bom" (
    "id" BIGSERIAL NOT NULL,
    "product_id" BIGINT NOT NULL,
    "component_id" BIGINT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL DEFAULT 1,

    CONSTRAINT "manufactured_bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installer_rates" (
    "id" BIGSERIAL NOT NULL,
    "region" TEXT NOT NULL,
    "location" TEXT,
    "installer" TEXT,
    "lcd" DECIMAL(12,2),
    "led" DECIMAL(12,2),
    "bracket" DECIMAL(12,2),
    "custom_works" DECIMAL(12,2),
    "custom_additional" DECIMAL(12,2),
    "permit" DECIMAL(12,2),
    "disposal" DECIMAL(12,2),
    "evening_works" DECIMAL(12,2),
    "gst" DECIMAL(8,4),
    "currency_id" BIGINT,

    CONSTRAINT "installer_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence_components" (
    "id" BIGSERIAL NOT NULL,
    "component" TEXT NOT NULL,
    "tier" "LicenceTier" NOT NULL,
    "screen_type" "ScreenType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "licence_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hardware_support_components" (
    "id" BIGSERIAL NOT NULL,
    "component" TEXT NOT NULL,
    "tier" "LicenceTier" NOT NULL,
    "screen_type" "ScreenType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "hardware_support_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "international_support_rates" (
    "id" BIGSERIAL NOT NULL,
    "partner" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "rate_label" TEXT NOT NULL,
    "local_value" DECIMAL(12,2),
    "local_currency_id" BIGINT,
    "aud_value" DECIMAL(12,2),
    "sell_value" DECIMAL(12,2),

    CONSTRAINT "international_support_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "international_install_rates" (
    "id" BIGSERIAL NOT NULL,
    "partner" TEXT NOT NULL,
    "region" TEXT,
    "rate_label" TEXT NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,
    "currency_id" BIGINT,

    CONSTRAINT "international_install_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "international_vat" (
    "id" BIGSERIAL NOT NULL,
    "region" TEXT NOT NULL,
    "vat_multiplier" DECIMAL(8,4) NOT NULL,

    CONSTRAINT "international_vat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "software_activities" (
    "id" BIGSERIAL NOT NULL,
    "activity" TEXT NOT NULL,
    "cost" DECIMAL(12,4) NOT NULL,
    "sell" DECIMAL(12,4) NOT NULL,
    "ratio" DECIMAL(8,4),

    CONSTRAINT "software_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_products" (
    "id" BIGSERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_url" TEXT,
    "cost" DECIMAL(12,2),
    "sell" DECIMAL(12,2),

    CONSTRAINT "audio_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "music_services" (
    "id" BIGSERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cost" DECIMAL(12,2),
    "sell" DECIMAL(12,2),
    "sqm_min" INTEGER,
    "sqm_max" INTEGER,

    CONSTRAINT "music_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hypervsn_products" (
    "id" BIGSERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sell_aud" DECIMAL(12,2),
    "reseller_aud" DECIMAL(12,2),
    "sell_nzd" DECIMAL(12,2),
    "reseller_nzd" DECIMAL(12,2),

    CONSTRAINT "hypervsn_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "margin_note" TEXT,
    "led_screen_note" TEXT,
    "gob_note" TEXT,
    "mediaplayer_note" TEXT,
    "ratio_note" TEXT,
    "default_margin" DECIMAL(8,4),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" BIGSERIAL NOT NULL,
    "job_reference" TEXT NOT NULL,
    "client_id" BIGINT,
    "location_id" BIGINT,
    "currency_id" BIGINT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "reseller_markup" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "valid_until" TIMESTAMP(3),
    "requested_shipping_date" TIMESTAMP(3),
    "estimated_cost" DECIMAL(12,2),
    "actual_cost" DECIMAL(12,2),
    "total_equipment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_services" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_recurring" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_by" BIGINT NOT NULL,
    "updated_by" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_led_screens" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "screen_name" TEXT,
    "led_product_id" BIGINT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "desired_width_mm" INTEGER,
    "desired_height_mm" INTEGER,
    "rotate_cabinets" BOOLEAN NOT NULL DEFAULT false,
    "gob_id" BIGINT,
    "frame_id" BIGINT,
    "trim_id" BIGINT,
    "hanging_bar_id" BIGINT,
    "engineering_id" BIGINT,
    "install_method_id" BIGINT,
    "freight_option_id" BIGINT,
    "warranty_id" BIGINT,
    "service_hours_id" BIGINT,
    "access_equipment_id" BIGINT,
    "margin_override" DECIMAL(8,4),
    "resolution_w_px" INTEGER,
    "resolution_h_px" INTEGER,
    "total_pixels" BIGINT,
    "weight_kg" DECIMAL(10,2),
    "power_avg_w" INTEGER,
    "power_max_w" INTEGER,
    "heat_avg_btu" INTEGER,
    "heat_max_btu" INTEGER,
    "cabinet_depth_mm" INTEGER,
    "recess_size" TEXT,
    "freight_kg" DECIMAL(10,2),
    "labour_hours" DECIMAL(8,2),
    "spare_modules_pct" DECIMAL(6,2),
    "spare_hub_card" INTEGER,
    "spare_power_supply" INTEGER,
    "power_supply_spec" TEXT,
    "cabinet_sizes" TEXT,
    "protective_package" TEXT,
    "gob_coating_note" TEXT,
    "brackets_note" TEXT,
    "controller_seen_ref" TEXT,
    "led_size" TEXT,
    "data_spec" TEXT,
    "service_access" TEXT,
    "physical_install" TEXT,
    "power_and_data" TEXT,
    "estimated_cost" DECIMAL(12,2),
    "actual_cost" DECIMAL(12,2),
    "price_screen_mediaplayer" DECIMAL(12,2),
    "price_frame_trim" DECIMAL(12,2),
    "price_services" DECIMAL(12,2),
    "price_total" DECIMAL(12,2),

    CONSTRAINT "quote_led_screens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_led_components" (
    "id" BIGSERIAL NOT NULL,
    "quote_led_screen_id" BIGINT NOT NULL,
    "component_type" "LedComponentType" NOT NULL,
    "controller_id" BIGINT,
    "led_peripheral_id" BIGINT,
    "mediaplayer_id" BIGINT,
    "peripheral_id" BIGINT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_cost_snapshot" DECIMAL(12,2),
    "unit_sell_snapshot" DECIMAL(12,2),

    CONSTRAINT "quote_led_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_led_cost_breakdown" (
    "id" BIGSERIAL NOT NULL,
    "quote_led_screen_id" BIGINT NOT NULL,
    "line_label" TEXT NOT NULL,
    "category" TEXT,
    "cost" DECIMAL(12,2),
    "sell" DECIMAL(12,2),

    CONSTRAINT "quote_led_cost_breakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lcd_screens" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "screen_name" TEXT,
    "display_id" BIGINT,
    "install_method_id" BIGINT,
    "service_hours_id" BIGINT,
    "warranty_id" BIGINT,
    "price_screen_mediaplayer" DECIMAL(12,2),
    "price_bracket_shroud" DECIMAL(12,2),
    "price_services" DECIMAL(12,2),
    "price_total" DECIMAL(12,2),
    "labour_hours" DECIMAL(8,2),
    "data_spec" TEXT,
    "service_access" TEXT,
    "physical_install" TEXT,
    "power_and_data" TEXT,
    "estimated_cost" DECIMAL(12,2),
    "actual_cost" DECIMAL(12,2),

    CONSTRAINT "quote_lcd_screens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lcd_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_lcd_screen_id" BIGINT NOT NULL,
    "display_id" BIGINT,
    "item_type" "LcdItemType" NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit_cost" DECIMAL(12,2),
    "unit_sell" DECIMAL(12,2),

    CONSTRAINT "quote_lcd_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_mediaplayers" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "mediaplayer_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quote_mediaplayers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_peripherals" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "peripheral_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quote_peripherals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_manufactured_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quote_manufactured_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_audio_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "audio_product_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quote_audio_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_music_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "music_service_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quote_music_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_hypervsn_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "hypervsn_product_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "rate_card" "HypervsnRateCard" NOT NULL DEFAULT 'aud',

    CONSTRAINT "quote_hypervsn_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_software_items" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "software_activity_id" BIGINT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL DEFAULT 1,

    CONSTRAINT "quote_software_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_licences" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "licence_component_id" BIGINT,
    "screen_type" "ScreenType" NOT NULL,
    "tier" "LicenceTier" NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "is_interactive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "quote_licences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_terms" (
    "id" BIGSERIAL NOT NULL,
    "quote_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "quote_terms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "quote_audit_log_quote_id_idx" ON "quote_audit_log"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_revisions_quote_id_revision_no_key" ON "quote_revisions"("quote_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_currency_id_key" ON "exchange_rates"("currency_id");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "international_vat_region_key" ON "international_vat"("region");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_job_reference_key" ON "quotes"("job_reference");

-- CreateIndex
CREATE INDEX "quotes_client_id_idx" ON "quotes"("client_id");

-- CreateIndex
CREATE INDEX "quotes_status_idx" ON "quotes"("status");

-- CreateIndex
CREATE INDEX "quote_led_screens_quote_id_idx" ON "quote_led_screens"("quote_id");

-- CreateIndex
CREATE INDEX "quote_led_components_quote_led_screen_id_idx" ON "quote_led_components"("quote_led_screen_id");

-- CreateIndex
CREATE INDEX "quote_led_cost_breakdown_quote_led_screen_id_idx" ON "quote_led_cost_breakdown"("quote_led_screen_id");

-- CreateIndex
CREATE INDEX "quote_lcd_screens_quote_id_idx" ON "quote_lcd_screens"("quote_id");

-- CreateIndex
CREATE INDEX "quote_lcd_items_quote_lcd_screen_id_idx" ON "quote_lcd_items"("quote_lcd_screen_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_audit_log" ADD CONSTRAINT "quote_audit_log_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_audit_log" ADD CONSTRAINT "quote_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seafreight_rates" ADD CONSTRAINT "seafreight_rates_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "led_commentary" ADD CONSTRAINT "led_commentary_led_product_id_fkey" FOREIGN KEY ("led_product_id") REFERENCES "led_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufactured_bom" ADD CONSTRAINT "manufactured_bom_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "manufactured_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufactured_bom" ADD CONSTRAINT "manufactured_bom_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "manufactured_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installer_rates" ADD CONSTRAINT "installer_rates_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "international_support_rates" ADD CONSTRAINT "international_support_rates_local_currency_id_fkey" FOREIGN KEY ("local_currency_id") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "international_install_rates" ADD CONSTRAINT "international_install_rates_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_led_product_id_fkey" FOREIGN KEY ("led_product_id") REFERENCES "led_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_gob_id_fkey" FOREIGN KEY ("gob_id") REFERENCES "gob_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "frames"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_trim_id_fkey" FOREIGN KEY ("trim_id") REFERENCES "trim_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_hanging_bar_id_fkey" FOREIGN KEY ("hanging_bar_id") REFERENCES "hanging_bar_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_engineering_id_fkey" FOREIGN KEY ("engineering_id") REFERENCES "engineering_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_install_method_id_fkey" FOREIGN KEY ("install_method_id") REFERENCES "install_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_freight_option_id_fkey" FOREIGN KEY ("freight_option_id") REFERENCES "freight_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "warranty_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_service_hours_id_fkey" FOREIGN KEY ("service_hours_id") REFERENCES "service_hours_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_access_equipment_id_fkey" FOREIGN KEY ("access_equipment_id") REFERENCES "access_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_quote_led_screen_id_fkey" FOREIGN KEY ("quote_led_screen_id") REFERENCES "quote_led_screens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_controller_id_fkey" FOREIGN KEY ("controller_id") REFERENCES "controllers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_led_peripheral_id_fkey" FOREIGN KEY ("led_peripheral_id") REFERENCES "led_peripherals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_mediaplayer_id_fkey" FOREIGN KEY ("mediaplayer_id") REFERENCES "mediaplayers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_peripheral_id_fkey" FOREIGN KEY ("peripheral_id") REFERENCES "peripherals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_cost_breakdown" ADD CONSTRAINT "quote_led_cost_breakdown_quote_led_screen_id_fkey" FOREIGN KEY ("quote_led_screen_id") REFERENCES "quote_led_screens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_display_id_fkey" FOREIGN KEY ("display_id") REFERENCES "display_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_install_method_id_fkey" FOREIGN KEY ("install_method_id") REFERENCES "install_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_service_hours_id_fkey" FOREIGN KEY ("service_hours_id") REFERENCES "service_hours_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "warranty_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_items" ADD CONSTRAINT "quote_lcd_items_quote_lcd_screen_id_fkey" FOREIGN KEY ("quote_lcd_screen_id") REFERENCES "quote_lcd_screens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_items" ADD CONSTRAINT "quote_lcd_items_display_id_fkey" FOREIGN KEY ("display_id") REFERENCES "display_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_mediaplayers" ADD CONSTRAINT "quote_mediaplayers_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_mediaplayers" ADD CONSTRAINT "quote_mediaplayers_mediaplayer_id_fkey" FOREIGN KEY ("mediaplayer_id") REFERENCES "mediaplayers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_peripherals" ADD CONSTRAINT "quote_peripherals_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_peripherals" ADD CONSTRAINT "quote_peripherals_peripheral_id_fkey" FOREIGN KEY ("peripheral_id") REFERENCES "peripherals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_manufactured_items" ADD CONSTRAINT "quote_manufactured_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_manufactured_items" ADD CONSTRAINT "quote_manufactured_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "manufactured_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_audio_items" ADD CONSTRAINT "quote_audio_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_audio_items" ADD CONSTRAINT "quote_audio_items_audio_product_id_fkey" FOREIGN KEY ("audio_product_id") REFERENCES "audio_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_music_items" ADD CONSTRAINT "quote_music_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_music_items" ADD CONSTRAINT "quote_music_items_music_service_id_fkey" FOREIGN KEY ("music_service_id") REFERENCES "music_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_hypervsn_items" ADD CONSTRAINT "quote_hypervsn_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_hypervsn_items" ADD CONSTRAINT "quote_hypervsn_items_hypervsn_product_id_fkey" FOREIGN KEY ("hypervsn_product_id") REFERENCES "hypervsn_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_software_items" ADD CONSTRAINT "quote_software_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_software_items" ADD CONSTRAINT "quote_software_items_software_activity_id_fkey" FOREIGN KEY ("software_activity_id") REFERENCES "software_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_licences" ADD CONSTRAINT "quote_licences_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_licences" ADD CONSTRAINT "quote_licences_licence_component_id_fkey" FOREIGN KEY ("licence_component_id") REFERENCES "licence_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_terms" ADD CONSTRAINT "quote_terms_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
