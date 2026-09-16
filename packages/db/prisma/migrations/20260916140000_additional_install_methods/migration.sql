-- Ensure the standard install-method catalogue, and add the newly requested options
-- (On-Glass, Recessed, Hanging, Into Client Housing).
--
-- DATA-only migration (no schema change). These options were requested after the original three
-- (Wall Mount / Ceiling Mount / Freestanding) were seeded, and `seedIfEmpty` skips any table that
-- already has rows — so a re-seed would never deliver them to an existing database. Running the
-- full seed is not a safe alternative here either: it re-upserts every `settings` row back to its
-- default, discarding admin-tuned margins and engine bumpers.
--
-- `default_hours` is 4 to match the existing three methods and the code's own fallback
-- (estimateInstallHours' baseHours). It is NOT an estimate of how long each method really takes --
-- the workbook gives no per-method hours. Admins set the real figures in
-- Reference data -> Install Methods.
--
-- Idempotent: inserts only names that are absent, so a re-run is a no-op and existing rows
-- (including any tuned hours) are left untouched.
INSERT INTO "install_methods" ("name", "default_hours")
SELECT v.name, 4
FROM (VALUES
  -- The original three. Present in the seed since day one, but a database seeded before that (or
  -- one whose rows were removed) can be missing them entirely -- topping up here makes this
  -- migration ensure the whole standard catalogue, not just the additions.
  ('Wall Mount'),
  ('Ceiling Mount'),
  ('Freestanding'),
  -- Newly requested options.
  ('On-Glass'),
  ('Recessed'),
  ('Hanging'),
  ('Into Client Housing')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "install_methods" im WHERE im."name" = v.name
);
