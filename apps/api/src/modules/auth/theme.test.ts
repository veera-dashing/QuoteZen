import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Theme preference — self-service persistence. Login returns the stored theme; PATCH /auth/me
 * updates it (persisted to the DB); GET /auth/me reflects the fresh value. Invalid values reject.
 */
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json();

beforeAll(async () => {
  app = await buildApp(loadConfig());
  token = (await login('sales@quotezen.local')).token as string;
});

afterAll(async () => {
  // Leave the demo user back on the default so other tests / demos are unaffected.
  await prisma.user
    .update({ where: { email: 'sales@quotezen.local' }, data: { themePreference: 'dark' } })
    .catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('theme preference', () => {
  it('login returns the persisted themePreference (defaults to dark)', async () => {
    const res = await login('sales@quotezen.local');
    expect(res.user.themePreference).toBeDefined();
    expect(['light', 'dark']).toContain(res.user.themePreference);
  });

  it('PATCH /auth/me persists the theme and GET /auth/me reflects it', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { themePreference: 'light' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().user.themePreference).toBe('light');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth() });
    expect(me.json().user.themePreference).toBe('light');

    // Persisted in the DB, not just the response.
    const row = await prisma.user.findUniqueOrThrow({ where: { email: 'sales@quotezen.local' } });
    expect(row.themePreference).toBe('light');
  });

  it('rejects an invalid theme value (422 validation)', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: auth(),
      payload: { themePreference: 'neon' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('requires auth (401 without a token)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/auth/me', payload: { themePreference: 'dark' } });
    expect(res.statusCode).toBe(401);
  });
});
