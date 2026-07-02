import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA2 — LED selection rules (live RDS integration). Verifies:
 *  (a) a client with `allowedRatios` restricts the `configure` results / flags RATIO_NOT_ALLOWED;
 *  (b) a controller whose compatibilityGroup differs from the screen product's yields
 *      CONTROLLER_SCREEN_MISMATCH (error) via GET /quotes/:id/validate;
 *  (c) a content-ratio that differs from the achieved ratio → CONTENT_RATIO_MISMATCH (warning);
 *  (d) a client `preferredPitchMm` that differs from the product pitch → PITCH_NOT_CLIENT_PREFERRED.
 *
 * Self-cleaning: quotes use a job-ref prefix; the client rows this test creates are deleted in
 * afterAll (the shared catalogue rows are left untouched — we only READ their fields).
 */
const JOB_PREFIX = `TESTAA2-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

// A product that snaps cleanly to a portrait/landscape ratio we can constrain against.
let productId: string;
let productPitch: number;
let productRatioLabel: string;
// A controller carrying a compatibility group that DIFFERS from the product's (product group left null).
let mismatchControllerId: string;

let restrictClientId: bigint; // allowedRatios excludes the product's achieved ratio
let allowClientId: bigint; // allowedRatios includes the achieved ratio
let pitchClientId: bigint; // preferredPitchMm differs from the product pitch

const createdClientIds: bigint[] = [];

interface Finding { rule: string; severity: string }
interface ValidateResp { screens: Array<{ findings: Finding[] }> }
interface ConfigResp { options: Array<{ productId: string; ratioLabel: string | null }>; reasons: string[] }

/** Create an admin-owned quote for a client + add one LED screen (product + optional mismatch controller). */
const quoteWithScreen = async (
  clientId: bigint,
  opts: { controllerId?: string; contentRatio?: string } = {},
): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: bearer(adminToken),
    payload: { jobReference: jobRef(), currencyCode: 'AUD', clientId: Number(clientId) },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const screen = await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers: bearer(adminToken),
    payload: {
      ledProductId: Number(productId),
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      rotateCabinets: false,
      ...(opts.contentRatio ? { contentRatio: opts.contentRatio } : {}),
      ...(opts.controllerId
        ? { components: [{ componentType: 'controller', controllerId: Number(opts.controllerId), qty: 1 }] }
        : {}),
    },
  });
  expect(screen.statusCode).toBe(201);
  return id;
};

const validate = async (quoteId: string): Promise<ValidateResp> => {
  const res = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/validate`, headers: bearer(adminToken) });
  expect(res.statusCode).toBe(200);
  return res.json() as ValidateResp;
};
const allFindings = (v: ValidateResp): Finding[] => v.screens.flatMap((s) => s.findings);

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');

  // Pick a fully-specified LED product and compute the ratio the fixed opening (1120×1920, no rotate)
  // will snap to, so the allowed/content-ratio expectations are deterministic against the live catalogue.
  const product = await prisma.ledProduct.findFirst({
    where: {
      deprecated: false,
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchH: { not: null },
      pixelPitchV: { not: null },
    },
    orderBy: { id: 'asc' },
  });
  if (!product) throw new Error('Expected a fully-specified LED product in the catalogue');
  productId = product.id.toString();
  productPitch = Number(product.pixelPitchH);

  // Controller with a compatibility group that will differ from the (null-group) product → mismatch.
  const ctrl = await prisma.controller.findFirst({
    where: { compatibilityGroup: { not: null } },
    orderBy: { id: 'asc' },
  });
  if (!ctrl) throw new Error('Expected a controller with a compatibility group (seeded "HX")');
  mismatchControllerId = ctrl.id.toString();
  // Ensure the product used has a DIFFERENT group than the controller so the mismatch fires and is not
  // the seeded HX product (which shares the controller's group). Force the product group to a distinct value.
  await prisma.ledProduct.update({ where: { id: product.id }, data: { compatibilityGroup: 'AA2-TESTGRP' } });

  // Clients. We create these fresh and delete them afterwards.
  const restrict = await prisma.client.create({ data: { name: `${JOB_PREFIX}restrict`, allowedRatios: '99:1' } });
  restrictClientId = restrict.id;
  const pitchClient = await prisma.client.create({
    data: { name: `${JOB_PREFIX}pitch`, preferredPitchMm: productPitch + 1 },
  });
  pitchClientId = pitchClient.id;
  createdClientIds.push(restrictClientId, pitchClientId);

  // Discover the achieved ratio label via configure on a real quote, then make an allow-client for it.
  const probeQuote = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: bearer(adminToken),
    payload: { jobReference: jobRef(), currencyCode: 'AUD' },
  });
  const probeId = probeQuote.json().id as string;
  const cfg = await app.inject({
    method: 'POST',
    url: `/quotes/${probeId}/screens/configure`,
    headers: bearer(adminToken),
    payload: { desiredWidthMm: 1120, desiredHeightMm: 1920, allowRotation: false },
  });
  const cfgBody = cfg.json() as ConfigResp;
  const forProduct = cfgBody.options.find((o) => o.productId === productId) ?? cfgBody.options[0];
  productRatioLabel = forProduct?.ratioLabel ?? '9:16';

  const allow = await prisma.client.create({
    data: { name: `${JOB_PREFIX}allow`, allowedRatios: productRatioLabel },
  });
  allowClientId = allow.id;
  createdClientIds.push(allowClientId);
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  // Restore the product's compatibility group (we forced it to a test value) and remove test clients.
  await prisma.ledProduct.update({ where: { id: BigInt(productId) }, data: { compatibilityGroup: null } }).catch(() => undefined);
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe('AA2 — LED selection rules', () => {
  it('(a) allowedRatios restricts configure results + a stored screen flags RATIO_NOT_ALLOWED', async () => {
    // configure for a quote on the restrict client (allowed = 99:1, which no build satisfies) → empty+reason.
    const q = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: bearer(adminToken),
      payload: { jobReference: jobRef(), currencyCode: 'AUD', clientId: Number(restrictClientId) },
    });
    const qid = q.json().id as string;
    const cfg = await app.inject({
      method: 'POST',
      url: `/quotes/${qid}/screens/configure`,
      headers: bearer(adminToken),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920, allowRotation: false },
    });
    expect(cfg.statusCode).toBe(200);
    const body = cfg.json() as ConfigResp;
    expect(body.options.length).toBe(0);
    expect(body.reasons.some((r) => /allowed ratios/.test(r))).toBe(true);

    // Allowing the achieved ratio returns options (all in the allowed set).
    const qa = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: bearer(adminToken),
      payload: { jobReference: jobRef(), currencyCode: 'AUD', clientId: Number(allowClientId) },
    });
    const qaid = qa.json().id as string;
    const cfgOk = await app.inject({
      method: 'POST',
      url: `/quotes/${qaid}/screens/configure`,
      headers: bearer(adminToken),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920, allowRotation: false },
    });
    const okBody = cfgOk.json() as ConfigResp;
    expect(okBody.options.length).toBeGreaterThan(0);
    for (const o of okBody.options) expect(o.ratioLabel).toBe(productRatioLabel);

    // A STORED screen on the restrict client whose achieved ratio is outside the allowed set → warning.
    const storedQuote = await quoteWithScreen(restrictClientId);
    const v = await validate(storedQuote);
    expect(allFindings(v).some((f) => f.rule === 'RATIO_NOT_ALLOWED' && f.severity === 'warning')).toBe(true);
  });

  it('(b) a controller with a differing compatibility group → CONTROLLER_SCREEN_MISMATCH (error)', async () => {
    const quoteId = await quoteWithScreen(allowClientId, { controllerId: mismatchControllerId });
    const v = await validate(quoteId);
    expect(allFindings(v).some((f) => f.rule === 'CONTROLLER_SCREEN_MISMATCH' && f.severity === 'error')).toBe(true);
  });

  it('(c) a content ratio differing from the achieved ratio → CONTENT_RATIO_MISMATCH (warning)', async () => {
    // A content ratio that can never equal any real achieved ratio label → guaranteed mismatch.
    const quoteId = await quoteWithScreen(allowClientId, { contentRatio: '123:1' });
    const v = await validate(quoteId);
    expect(allFindings(v).some((f) => f.rule === 'CONTENT_RATIO_MISMATCH' && f.severity === 'warning')).toBe(true);
  });

  it('(d) a client preferred pitch differing from the product pitch → PITCH_NOT_CLIENT_PREFERRED (warning)', async () => {
    const quoteId = await quoteWithScreen(pitchClientId);
    const v = await validate(quoteId);
    expect(allFindings(v).some((f) => f.rule === 'PITCH_NOT_CLIENT_PREFERRED' && f.severity === 'warning')).toBe(true);
  });
});
