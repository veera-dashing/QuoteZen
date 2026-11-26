import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Client margin / discount (and the client-tier default discount) are stored as FRACTIONS but shown and
 * entered as PERCENTAGES in the admin UI — the registry flags them `percent`. The API keeps fractions.
 */
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@quotezen.local', password: 'demo' } })
  ).json().token as string;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('percent fields', () => {
  it('client margin/discount and tier discount are flagged percent, still bounded 0..<1 as fractions', async () => {
    const meta = (await app.inject({ method: 'GET', url: '/admin/_meta', headers: { authorization: `Bearer ${token}` } })).json() as {
      tables: Array<{ resource: string; fields: Array<{ name: string; label: string; percent?: boolean; min?: number; lessThan?: number }> }>;
    };
    const field = (resource: string, name: string) =>
      meta.tables.find((t) => t.resource === resource)!.fields.find((f) => f.name === name)!;
    for (const [resource, name] of [
      ['clients', 'defaultMargin'],
      ['clients', 'discountPct'],
      ['client-tiers', 'defaultDiscountPct'],
    ] as const) {
      const f = field(resource, name);
      expect(f.percent).toBe(true);
      expect(f.label).toMatch(/\(%\)$/);
      expect(f.min).toBe(0);
      expect(f.lessThan).toBe(1); // the API still validates the stored fraction
    }
    expect(field('clients', 'name').percent).toBeUndefined();
  });
});
