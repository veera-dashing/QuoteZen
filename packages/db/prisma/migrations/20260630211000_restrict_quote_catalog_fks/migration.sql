-- DropForeignKey
ALTER TABLE "quote_lcd_items" DROP CONSTRAINT "quote_lcd_items_display_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_lcd_screens" DROP CONSTRAINT "quote_lcd_screens_display_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_lcd_screens" DROP CONSTRAINT "quote_lcd_screens_install_method_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_lcd_screens" DROP CONSTRAINT "quote_lcd_screens_service_hours_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_lcd_screens" DROP CONSTRAINT "quote_lcd_screens_warranty_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_components" DROP CONSTRAINT "quote_led_components_controller_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_components" DROP CONSTRAINT "quote_led_components_led_peripheral_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_components" DROP CONSTRAINT "quote_led_components_mediaplayer_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_components" DROP CONSTRAINT "quote_led_components_peripheral_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_access_equipment_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_engineering_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_frame_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_freight_option_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_gob_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_hanging_bar_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_install_method_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_led_product_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_service_hours_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_trim_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_led_screens" DROP CONSTRAINT "quote_led_screens_warranty_id_fkey";

-- DropForeignKey
ALTER TABLE "quote_licences" DROP CONSTRAINT "quote_licences_licence_component_id_fkey";

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_led_product_id_fkey" FOREIGN KEY ("led_product_id") REFERENCES "led_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_gob_id_fkey" FOREIGN KEY ("gob_id") REFERENCES "gob_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "frames"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_trim_id_fkey" FOREIGN KEY ("trim_id") REFERENCES "trim_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_hanging_bar_id_fkey" FOREIGN KEY ("hanging_bar_id") REFERENCES "hanging_bar_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_engineering_id_fkey" FOREIGN KEY ("engineering_id") REFERENCES "engineering_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_install_method_id_fkey" FOREIGN KEY ("install_method_id") REFERENCES "install_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_freight_option_id_fkey" FOREIGN KEY ("freight_option_id") REFERENCES "freight_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "warranty_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_service_hours_id_fkey" FOREIGN KEY ("service_hours_id") REFERENCES "service_hours_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_screens" ADD CONSTRAINT "quote_led_screens_access_equipment_id_fkey" FOREIGN KEY ("access_equipment_id") REFERENCES "access_equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_controller_id_fkey" FOREIGN KEY ("controller_id") REFERENCES "controllers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_led_peripheral_id_fkey" FOREIGN KEY ("led_peripheral_id") REFERENCES "led_peripherals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_mediaplayer_id_fkey" FOREIGN KEY ("mediaplayer_id") REFERENCES "mediaplayers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_led_components" ADD CONSTRAINT "quote_led_components_peripheral_id_fkey" FOREIGN KEY ("peripheral_id") REFERENCES "peripherals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_display_id_fkey" FOREIGN KEY ("display_id") REFERENCES "display_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_install_method_id_fkey" FOREIGN KEY ("install_method_id") REFERENCES "install_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_service_hours_id_fkey" FOREIGN KEY ("service_hours_id") REFERENCES "service_hours_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_screens" ADD CONSTRAINT "quote_lcd_screens_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "warranty_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lcd_items" ADD CONSTRAINT "quote_lcd_items_display_id_fkey" FOREIGN KEY ("display_id") REFERENCES "display_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_licences" ADD CONSTRAINT "quote_licences_licence_component_id_fkey" FOREIGN KEY ("licence_component_id") REFERENCES "licence_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

