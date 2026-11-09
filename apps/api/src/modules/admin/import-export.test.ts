import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { csvBoolean } from './routes.js';

/**
 * Bulk import/export (P1-06.4 / P1-06.5) exercised through the `clients` table (cheap, no FK
 * dependants). All created rows use the `ZZ-IE-` name prefix and are cleaned up afterward.
 */
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const PREFIX = 'ZZ-IE-';

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const tag = (s: string) => `${PREFIX}${s}-${Math.floor(Math.random() * 1e9)}`;

describe('export', () => {
  it('returns CSV with a header row and an id column (admin only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/clients/export', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('clients.csv');
    const header = res.body.split('\n')[0]?.trim() ?? '';
    expect(header.startsWith('id,name')).toBe(true);
  });

  it('forbids export for a non-admin (sales)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sales@quotezen.local', password: 'demo' },
    });
    const salesToken = login.json().token as string;
    const res = await app.inject({
      method: 'GET',
      url: '/admin/clients/export',
      headers: { authorization: `Bearer ${salesToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('import preview (dry-run, never writes)', () => {
  it('flags an invalid row (missing required name) without creating anything', async () => {
    const before = await prisma.client.count();
    const goodName = tag('preview-good');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/clients/import/preview',
      headers: auth(),
      payload: { rows: [{ name: goodName }, { marginNote: 'no name here' }] },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      total: number;
      valid: number;
      invalid: number;
      willCreate: number;
      willUpdate: number;
      errors: Array<{ row: number; messages: string[] }>;
    };
    expect(report.total).toBe(2);
    expect(report.valid).toBe(1);
    expect(report.invalid).toBe(1);
    expect(report.willCreate).toBe(1);
    expect(report.errors[0]?.row).toBe(2);
    // Dry-run wrote nothing.
    expect(await prisma.client.count()).toBe(before);
    expect(await prisma.client.findFirst({ where: { name: goodName } })).toBeNull();
  });

  it('parses an uploaded multipart CSV', async () => {
    const csv = `name,marginNote\n${tag('csv-row')},from-csv\n`;
    const boundary = '----qztest';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="clients.csv"\r\n' +
      'Content-Type: text/csv\r\n\r\n' +
      `${csv}\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/clients/import/preview',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().willCreate).toBe(1);
  });
});

/** POST a CSV string as a multipart upload (what the admin "Import CSV" button sends). */
const uploadCsv = (url: string, csv: string) => {
  const boundary = '----qzcsv';
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="import.csv"\r\n' +
    'Content-Type: text/csv\r\n\r\n' +
    `${csv}\r\n--${boundary}--\r\n`;
  return app.inject({
    method: 'POST',
    url,
    headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
};

describe('boolean columns from CSV', () => {
  it('csvBoolean accepts true/false, yes/no, y/n, 1/0 (any case) and rejects anything else', () => {
    for (const v of ['true', 'TRUE', ' yes ', 'Y', '1', true, 1]) expect(csvBoolean.parse(v)).toBe(true);
    for (const v of ['false', 'False', 'no', 'N', '0', false, 0]) expect(csvBoolean.parse(v)).toBe(false);
    for (const v of ['maybe', '2', 'truthy']) expect(csvBoolean.safeParse(v).success).toBe(false);
  });

  it('a CSV with true/false text imports and stores real booleans', async () => {
    const yes = tag('bool-yes');
    const no = tag('bool-no');
    const csv = `name,requiresProtectiveCoating\n${yes},true\n${no},no\n`;
    const preview = await uploadCsv('/admin/clients/import/preview', csv);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ valid: 2, invalid: 0, willCreate: 2 });

    const confirm = await uploadCsv('/admin/clients/import', csv);
    expect(confirm.statusCode).toBe(200);
    expect((await prisma.client.findFirst({ where: { name: yes } }))?.requiresProtectiveCoating).toBe(true);
    expect((await prisma.client.findFirst({ where: { name: no } }))?.requiresProtectiveCoating).toBe(false);
  });
});

describe('export → re-import round trip (the documented price-update workflow)', () => {
  // An exported file, re-uploaded unchanged, must validate cleanly — before the boolean fix every row of
  // led-products and display-catalog was rejected. Preview only: nothing is written.
  for (const resource of ['led-products', 'display-catalog', 'controllers']) {
    it(`${resource}: an unchanged export previews with no invalid rows`, async () => {
      const exported = await app.inject({ method: 'GET', url: `/admin/${resource}/export`, headers: auth() });
      expect(exported.statusCode).toBe(200);
      const preview = await uploadCsv(`/admin/${resource}/import/preview`, exported.body);
      expect(preview.statusCode).toBe(200);
      const report = preview.json() as { total: number; invalid: number; willUpdate: number; errors: unknown[] };
      expect(report.errors).toEqual([]);
      expect(report.invalid).toBe(0);
      expect(report.willUpdate).toBe(report.total);
    });
  }

  it('the export carries the columns that were missing (ship depth, compatibility group, controller pixels)', async () => {
    const header = (body: string) => body.split('\n')[0]?.trim().split(',') ?? [];
    const led = await app.inject({ method: 'GET', url: '/admin/led-products/export', headers: auth() });
    expect(header(led.body)).toEqual(expect.arrayContaining(['shipDepthMm', 'compatibilityGroup']));
    const ctl = await app.inject({ method: 'GET', url: '/admin/controllers/export', headers: auth() });
    expect(header(ctl.body)).toContain('maxPixels');
  });
});

describe('import confirm (all-or-nothing upsert)', () => {
  it('creates and updates rows in a single transaction', async () => {
    // Seed one row to update.
    const seed = await prisma.client.create({ data: { name: tag('seed'), marginNote: 'original' } });
    const newName = tag('created');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/clients/import',
      headers: auth(),
      payload: {
        rows: [
          { name: newName }, // create
          { id: seed.id.toString(), name: seed.name, marginNote: 'updated-via-import' }, // update
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1, updated: 1 });

    const updated = await prisma.client.findUnique({ where: { id: seed.id } });
    expect(updated?.marginNote).toBe('updated-via-import');
    expect(await prisma.client.findFirst({ where: { name: newName } })).toBeTruthy();
  });

  it('aborts the whole import (422) when any row is invalid — nothing is written', async () => {
    const before = await prisma.client.count();
    const wouldBeName = tag('rejected');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/clients/import',
      headers: auth(),
      payload: { rows: [{ name: wouldBeName }, { marginNote: 'missing name' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.invalid).toBe(1);
    // All-or-nothing: the valid row was NOT created.
    expect(await prisma.client.count()).toBe(before);
    expect(await prisma.client.findFirst({ where: { name: wouldBeName } })).toBeNull();
  });
});
