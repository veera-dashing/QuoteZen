/**
 * Import the bulk product catalogs extracted from the workbook (see extract_catalog.py) into the DB.
 *
 * Idempotent: each table is loaded only when empty, unless RECREATE=1 is set (which clears the table
 * first — safe for reference tables that quotes don't yet reference). Run after `pnpm db:seed`.
 *   pnpm --filter @quotezen/db exec tsx prisma/import-catalogs.ts
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const here = dirname(fileURLToPath(import.meta.url));
const RECREATE = process.env.RECREATE === '1';

type Row = Record<string, unknown>;
const data = JSON.parse(readFileSync(resolve(here, 'data/catalog.json'), 'utf8')) as Record<string, Row[]>;

const int = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v));

/** Coerce the LED spec columns that map to integer DB types. */
const LED_INT_FIELDS = [
  'moduleWMm', 'moduleHMm', 'minCabinetWMm', 'minCabinetHMm', 'cabinetDepthMm',
  'powerMaxW', 'powerAvgW', 'shipDepthMm', 'brightnessNits',
];

async function load(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegate: { count: () => Promise<number>; createMany: (a: any) => Promise<{ count: number }>; deleteMany: (a?: any) => Promise<unknown> },
  rows: Row[],
  transform?: (r: Row) => Row,
): Promise<void> {
  if (RECREATE) await delegate.deleteMany({});
  const count = await delegate.count();
  if (count > 0) {
    console.warn(`  ${table}: already has ${count} rows, skipping (set RECREATE=1 to reload)`);
    return;
  }
  const payload = transform ? rows.map(transform) : rows;
  const { count: inserted } = await delegate.createMany({ data: payload, skipDuplicates: true });
  console.warn(`  ${table}: inserted ${inserted}`);
}

async function main(): Promise<void> {
  console.warn('Importing catalogs from data/catalog.json…');

  await load('ledProducts', prisma.ledProduct, data.ledProducts ?? [], (r) => {
    const out: Row = { ...r };
    for (const f of LED_INT_FIELDS) out[f] = int(r[f]);
    return out;
  });
  await load('displayCatalog', prisma.displayCatalog, data.displayCatalog ?? []);
  await load('manufacturedProducts', prisma.manufacturedProduct, data.manufacturedProducts ?? [], (r) => ({
    ...r,
    brightness: int(r.brightness),
  }));
  await load('importCatalog', prisma.importCatalog, data.importCatalog ?? []);
  await load('audioProducts', prisma.audioProduct, data.audioProducts ?? []);
  await load('musicServices', prisma.musicService, data.musicServices ?? []);
  await load('hypervsnProducts', prisma.hypervsnProduct, data.hypervsnProducts ?? []);
  await load('softwareActivities', prisma.softwareActivity, data.softwareActivities ?? []);
  await load('ledCommentary', prisma.ledCommentary, data.ledCommentary ?? []);
  await load('internationalInstallRates', prisma.internationalInstallRate, data.internationalInstallRates ?? []);
  await load('hardwareSupportComponents', prisma.hardwareSupportComponent, data.hardwareSupportComponents ?? []);
  await load('installerRates', prisma.installerRate, data.installerRates ?? []);

  // internationalSupportRates: resolve localCurrency code → FK, then load (count-guarded).
  const currencies = await prisma.currency.findMany();
  const currencyId = new Map(currencies.map((c) => [c.code, c.id]));
  await load('internationalSupportRates', prisma.internationalSupportRate, data.internationalSupportRates ?? [], (r) => {
    const { localCurrency, ...rest } = r;
    return {
      ...rest,
      localCurrencyId: typeof localCurrency === 'string' ? currencyId.get(localCurrency) ?? null : null,
    };
  });

  // internationalVat has a unique region → upsert so it round-trips.
  for (const v of data.internationalVat ?? []) {
    await prisma.internationalVat.upsert({
      where: { region: String(v.region) },
      update: { vatMultiplier: Number(v.vatMultiplier) },
      create: { region: String(v.region), vatMultiplier: Number(v.vatMultiplier) },
    });
  }
  console.warn(`  internationalVat: ${(data.internationalVat ?? []).length} upserted`);

  console.warn('Catalog import complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
