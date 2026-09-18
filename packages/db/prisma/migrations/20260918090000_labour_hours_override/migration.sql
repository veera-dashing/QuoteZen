-- Manual override for a LED screen's install labour hours.
--
-- `labour_hours` already existed but is a COMPUTED OUTPUT: every re-price overwrites it with
-- estimateInstallHours(). Reusing it as the override would mean that editing any unrelated option on
-- a screen froze whatever the estimator last produced, silently turning an estimate into a fixed
-- figure. A separate nullable column keeps the two apart: null = derive it, a value = use it.
ALTER TABLE "quote_led_screens" ADD COLUMN "labour_hours_override" DECIMAL(8,2);
