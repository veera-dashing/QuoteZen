-- Per-client standing requirement: this client always wants protective coating on their LED screens.
--
-- Captured alongside the other per-client preferences (preferred freight / pitch / product family).
-- Advisory: it records the requirement so estimators see it; the coating itself is still selected per
-- screen from `coating_options`, which is what prices it.
--
-- NOT NULL with a false default, so every existing client reads as "no standing requirement".
ALTER TABLE "clients" ADD COLUMN "requires_protective_coating" BOOLEAN NOT NULL DEFAULT false;
