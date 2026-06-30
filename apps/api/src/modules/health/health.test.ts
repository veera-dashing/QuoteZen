import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { assertConfig, loadConfig } from '../../config.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadConfig());
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('health/readiness probes', () => {
  it('GET /health returns 200 ok without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 200 ready when the DB is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('boot config validation', () => {
  it('loadConfig throws on missing required env (fail-closed)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
  });

  it('assertConfig returns parsed config when env is valid', () => {
    const config = assertConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 'supersecret',
    } as NodeJS.ProcessEnv);
    expect(config.DATABASE_URL).toBe('postgres://x');
    expect(config.API_PORT).toBe(4000);
  });
});
