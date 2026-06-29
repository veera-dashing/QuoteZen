import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/** Generic CRUD tests, exercised through the `clients` table (cheap, no FK dependants). */
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

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
  await prisma.client.deleteMany({ where: { name: { startsWith: 'ZZ-TEST-' } } });
  await app.close();
  await prisma.$disconnect();
});

describe('admin meta', () => {
  it('exposes the table registry', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/_meta', headers: auth() });
    expect(res.statusCode).toBe(200);
    const tables = res.json().tables as Array<{ resource: string }>;
    expect(tables.find((t) => t.resource === 'led-products')).toBeTruthy();
    expect(tables.find((t) => t.resource === 'display-catalog')).toBeTruthy();
  });
});

describe('catalog data is present (imported)', () => {
  it('lists LED products with a total count', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/led-products?take=5', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; total: number };
    expect(body.total).toBeGreaterThan(100);
    expect(body.rows.length).toBe(5);
  });

  it('searches the display catalog', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/display-catalog?q=philips&take=3',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
  });
});

describe('generic CRUD (clients)', () => {
  it('creates, reads, updates and deletes a row', async () => {
    const name = `ZZ-TEST-${Math.floor(Math.random() * 1e9)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: auth(),
      payload: { name, marginNote: 'temp' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${id}`,
      headers: auth(),
      payload: { marginNote: 'updated' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().marginNote).toBe('updated');

    const del = await app.inject({ method: 'DELETE', url: `/admin/clients/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: `/admin/clients/${id}`, headers: auth() });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects invalid create input with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: auth(),
      payload: {}, // missing required name
    });
    expect(res.statusCode).toBe(422);
  });

  it('404s an unknown resource', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/nope', headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});
