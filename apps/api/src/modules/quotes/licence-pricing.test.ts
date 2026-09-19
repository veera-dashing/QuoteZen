import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { computeLicenceAnnual, resolveLicenceRates } from './service.js';

describe('licence pricing unit & integration', () => {
  describe('resolveLicenceRates & computeLicenceAnnual', () => {
    it('uses fallback constants when DB rows are empty or missing', () => {
      const lowRates = resolveLicenceRates([], 'low', 'LED');
      expect(lowRates).toEqual({ siteFee: 270, perScreen: 125, interactiveUplift: 100 });

      const highRates = resolveLicenceRates(undefined, 'high', 'LCD');
      expect(highRates).toEqual({ siteFee: 165, perScreen: 95, interactiveUplift: 100 });
    });

    it('resolves custom rates from DB rows when present', () => {
      const customRows = [
        { component: 'Site Fee', tier: 'low', screenType: 'LED', value: 300 },
        { component: 'Licence Per Screen', tier: 'low', screenType: 'LED', value: 140 },
        { component: 'Interactive Licence Per Screen Uplift', tier: 'low', screenType: 'LED', value: 110 },
      ];
      const rates = resolveLicenceRates(customRows, 'low', 'LED');
      expect(rates).toEqual({ siteFee: 300, perScreen: 140, interactiveUplift: 110 });

      const annual = computeLicenceAnnual(
        { screenType: 'LED', tier: 'low', qty: 2, isInteractive: true },
        customRows,
      );
      // 300 + 2 * 140 + 2 * 110 = 300 + 280 + 220 = 800
      expect(annual.toString()).toBe('800');
    });

    it('calculates standard annual licence amounts correctly', () => {
      // 1 screen, low tier, non-interactive = 270 + 125 = 395
      expect(
        computeLicenceAnnual({ screenType: 'LED', tier: 'low', qty: 1, isInteractive: false }).toString(),
      ).toBe('395');

      // 2 screens, low tier, non-interactive = 270 + 2 * 125 = 520
      expect(
        computeLicenceAnnual({ screenType: 'LED', tier: 'low', qty: 2, isInteractive: false }).toString(),
      ).toBe('520');

      // 1 screen, low tier, interactive = 270 + 125 + 100 = 495
      expect(
        computeLicenceAnnual({ screenType: 'LED', tier: 'low', qty: 1, isInteractive: true }).toString(),
      ).toBe('495');

      // 1 screen, high tier, non-interactive = 165 + 95 = 260
      expect(
        computeLicenceAnnual({ screenType: 'LED', tier: 'high', qty: 1, isInteractive: false }).toString(),
      ).toBe('260');
    });
  });

  describe('quote licence API integration', () => {
    const JOB_PREFIX = `TESTLIC-${process.pid}-`;
    let app: FastifyInstance;
    let token: string;
    const auth = () => ({ authorization: `Bearer ${token}` });
    const createdQuoteIds: string[] = [];

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
      for (const id of createdQuoteIds) {
        await prisma.quote.delete({ where: { id: BigInt(id) } }).catch(() => {});
      }
    });

    it('adding a licence immediately updates quote totalRecurring and surfaces in /price', async () => {
      const qRes = await app.inject({
        method: 'POST',
        url: '/quotes',
        headers: auth(),
        payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
      });
      expect(qRes.statusCode).toBe(201);
      const quoteId = qRes.json().id as string;
      createdQuoteIds.push(quoteId);

      // Initially recurring is 0
      expect(Number(qRes.json().totalRecurring)).toBe(0);

      // Add a licence (1 screen, low tier)
      const licRes = await app.inject({
        method: 'POST',
        url: `/quotes/${quoteId}/licences`,
        headers: auth(),
        payload: { screenType: 'LED', tier: 'low', qty: 1, isInteractive: false },
      });
      expect(licRes.statusCode).toBe(201);
      const lic = licRes.json();
      expect(lic.id).toBeDefined();

      // Fetch quote: totalRecurring is now 395
      const getRes = await app.inject({
        method: 'GET',
        url: `/quotes/${quoteId}`,
        headers: auth(),
      });
      expect(getRes.statusCode).toBe(200);
      expect(Number(getRes.json().totalRecurring)).toBe(395);

      // Check itemised price endpoint
      const priceRes = await app.inject({
        method: 'POST',
        url: `/quotes/${quoteId}/price`,
        headers: auth(),
      });
      expect(priceRes.statusCode).toBe(200);
      const price = priceRes.json();
      expect(Number(price.totals.recurring)).toBe(395);
      expect(price.licences).toHaveLength(1);
      expect(price.licences[0].annual).toBe('395');

      // Delete licence
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/quotes/${quoteId}/licences/${lic.id}`,
        headers: auth(),
      });
      expect(delRes.statusCode).toBe(204);

      // Recurring drops back to 0
      const afterDel = await app.inject({
        method: 'GET',
        url: `/quotes/${quoteId}`,
        headers: auth(),
      });
      expect(Number(afterDel.json().totalRecurring)).toBe(0);
    });
  });
});
