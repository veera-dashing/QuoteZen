import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

const JOB_PREFIX = `TESTINTAKE-${process.pid}-`;
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

const newQuote = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD', resellerMarkup: 0 },
  });
  if (res.statusCode !== 201) {
    throw new Error(`Failed to create quote: HTTP ${res.statusCode} ${JSON.stringify(res.json())}`);
  }
  return res.json().id as string;
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  await prisma.user.count(); // Warm up connection pool
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

describe('Phase 1 — configure with LED Selection Tree intake', () => {
  it('passes intake answers, evaluates tree and returns matching options with caveats', async () => {
    const quoteId = await newQuote();

    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/screens/configure`,
      headers: auth(),
      payload: {
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        intake: {
          environment: 'Indoor',
          priority: 'Quality',
          curved: 'No',
          transparent: 'No',
          indoorLocation: 'On a wall',
          viewingIndoor: '1 to 2 metres',
        },
      },
    });

    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(res.json())}`);
    }
    const body = res.json();
    expect(body.options.length).toBeGreaterThan(0);
    expect(body.treeConstraints).toBeDefined();
    expect(body.treeConstraints.recommendedModelFamilies).toContain('BM-PRO');
    expect(body.treeConstraints.gobRequired).toBe(true);
    expect(body.primaryRecommendationText).toBeDefined();
  });

  it('filters to transparent products when transparent=Yes', async () => {
    const quoteId = await newQuote();

    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/screens/configure`,
      headers: auth(),
      payload: {
        desiredWidthMm: 1000,
        desiredHeightMm: 2000,
        intake: {
          environment: 'Indoor',
          priority: 'Value',
          transparent: 'Yes',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.treeConstraints?.transparentRequired).toBe(true);
    if (body.options.length > 0) {
      for (const opt of body.options) {
        expect(
          opt.model.toLowerCase().includes('tgc') ||
            opt.model.toLowerCase().includes('tg') ||
            opt.model.toLowerCase().includes('itd') ||
            opt.model.toLowerCase().includes('ts') ||
            opt.model.toLowerCase().includes('transparent') ||
            opt.model.toLowerCase().includes('muxwave'),
        ).toBe(true);
      }
    }
  });
});
