import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Integration tests for per-job file upload + deterministic re-run (P1-19e). Hits the live DB and
 * writes to the configured UPLOAD_DIR (gitignored). Self-cleaning: deletes its quotes + stored files.
 */
const JOB_PREFIX = `TEST-DOC-${process.pid}-`;
let app: FastifyInstance;
let token: string;
let uploadDir: string;
const storedNames: string[] = [];

const authHeader = () => ({ authorization: `Bearer ${token}` });

/** Hand-build a multipart/form-data body (no extra deps) for app.inject. */
const multipart = (filename: string, mimeType: string, content: Buffer) => {
  const boundary = `----quotezenTest${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, content, tail]);
  return {
    payload,
    headers: { ...authHeader(), 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

beforeAll(async () => {
  const config = loadConfig();
  uploadDir = config.UPLOAD_DIR;
  app = await buildApp(config);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;
});

afterAll(async () => {
  for (const name of storedNames) {
    const p = join(uploadDir, name);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const createQuote = async (): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: authHeader(),
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

describe('per-job documents + re-run (P1-19e)', () => {
  it('uploads a file (v1), re-uploads the same name (v2), and downloads the bytes', async () => {
    const id = await createQuote();
    const content = Buffer.from('hello quotezen document');

    // Upload v1.
    const up1 = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/documents`,
      ...multipart('brief.txt', 'text/plain', content),
    });
    expect(up1.statusCode).toBe(201);
    const doc1 = up1.json() as { id: string; version: number; sizeBytes: number; originalName: string };
    expect(doc1.version).toBe(1);
    expect(doc1.originalName).toBe('brief.txt');
    expect(doc1.sizeBytes).toBe(content.length);

    // Verify the file is on disk.
    const row1 = await prisma.quoteDocument.findUnique({ where: { id: BigInt(doc1.id) } });
    expect(row1).not.toBeNull();
    storedNames.push(row1!.storedName);
    expect(existsSync(join(uploadDir, row1!.storedName))).toBe(true);

    // Re-upload the same name → version 2; v1 preserved.
    const up2 = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/documents`,
      ...multipart('brief.txt', 'text/plain', Buffer.from('revised brief')),
    });
    expect(up2.statusCode).toBe(201);
    const doc2 = up2.json() as { id: string; version: number };
    expect(doc2.version).toBe(2);
    const row2 = await prisma.quoteDocument.findUnique({ where: { id: BigInt(doc2.id) } });
    storedNames.push(row2!.storedName);

    // List → newest first, both versions present.
    const list = await app.inject({ method: 'GET', url: `/quotes/${id}/documents`, headers: authHeader() });
    expect(list.statusCode).toBe(200);
    const docs = list.json() as Array<{ version: number }>;
    expect(docs.map((d) => d.version)).toEqual([2, 1]);

    // Download v1 → exact bytes back.
    const dl = await app.inject({
      method: 'GET',
      url: `/quotes/${id}/documents/${doc1.id}/download`,
      headers: authHeader(),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('brief.txt');
    expect(dl.rawPayload.toString()).toBe(content.toString());

    // Delete v2 → row gone + file unlinked.
    const del = await app.inject({
      method: 'DELETE',
      url: `/quotes/${id}/documents/${doc2.id}`,
      headers: authHeader(),
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.quoteDocument.findUnique({ where: { id: BigInt(doc2.id) } })).toBeNull();
    expect(existsSync(join(uploadDir, row2!.storedName))).toBe(false);
  });

  it('rejects a disallowed file type with a typed 400', async () => {
    const id = await createQuote();
    const bad = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/documents`,
      ...multipart('evil.exe', 'application/x-msdownload', Buffer.from('MZ')),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
  });

  it('re-runs a quote: recompute + a new version with a change-summary label', async () => {
    const id = await createQuote();
    const res = await app.inject({ method: 'POST', url: `/quotes/${id}/rerun`, headers: authHeader() });
    expect(res.statusCode).toBe(201);
    const version = res.json() as { revisionNo: number; label: string | null };
    expect(version.revisionNo).toBeGreaterThanOrEqual(1);
    expect(version.label).toMatch(/^Re-run — grand total .* -> .*/);

    // The version is listed.
    const versions = await app.inject({ method: 'GET', url: `/quotes/${id}/versions`, headers: authHeader() });
    const labels = (versions.json() as Array<{ label: string | null }>).map((v) => v.label);
    expect(labels.some((l) => l?.startsWith('Re-run —'))).toBe(true);
  });
});
