import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

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
