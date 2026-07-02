import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA5 — software/hardware dependency intake fields (Group E). Verifies the quote-level dependency
 * fields round-trip through create → GET, and PATCH update + clear one.
 *
 * Live-RDS integration; self-cleans via a jobReference prefix.
 */
const JOB_PREFIX = `TESTAA5-${process.pid}-`;

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
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const DEPENDENCIES = {
  mediaPlayerSupply: 'Client-supplied',
  sharedDevicePlayers: 1,
  sharedDeviceScreens: 4,
  storeSizeSqm: 120.5,
  customContentCuration: true,
  pcRequired: true,
  hardDriveRequired: false,
} as const;

describe('AA5 — software/hardware dependency intake fields', () => {
  it('round-trips the dependency fields through create → GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}Q-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        ...DEPENDENCIES,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    const q = got.json();
    expect(q.mediaPlayerSupply).toBe(DEPENDENCIES.mediaPlayerSupply);
    expect(q.sharedDevicePlayers).toBe(1);
    expect(q.sharedDeviceScreens).toBe(4);
    expect(Number(q.storeSizeSqm)).toBe(120.5);
    expect(q.customContentCuration).toBe(true);
    expect(q.pcRequired).toBe(true);
    expect(q.hardDriveRequired).toBe(false);
  });

  it('updates (PATCH) and clears a dependency field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}QU-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD', ...DEPENDENCIES },
    });
    const id = created.json().id as string;
    const lockVersion = created.json().lockVersion as number;

    // Change one, clear another (nullish on update).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: auth(),
      payload: {
        expectedVersion: lockVersion,
        mediaPlayerSupply: 'Mandated',
        storeSizeSqm: null,
        pcRequired: false,
      },
    });
    expect(patched.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.mediaPlayerSupply).toBe('Mandated');
    expect(q.storeSizeSqm).toBeNull();
    expect(q.pcRequired).toBe(false);
    // Untouched fields stay.
    expect(q.sharedDevicePlayers).toBe(1);
    expect(q.sharedDeviceScreens).toBe(4);
    expect(q.customContentCuration).toBe(true);
  });
});
