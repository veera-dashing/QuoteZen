-- Standard cabinet dimensions for LED products (columns E & F in (LED 1) sheet).
-- Used for installer physical handling / labour estimation, while minCabinetWMm/HMm
-- remains for physical screen dimension snapping.
ALTER TABLE "led_products" ADD COLUMN "cabinet_w_mm" DECIMAL(10, 2);
ALTER TABLE "led_products" ADD COLUMN "cabinet_h_mm" DECIMAL(10, 2);
