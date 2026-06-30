import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { prisma } from '@quotezen/db';
import { AppError, notFound } from '../../errors.js';
import { recordAudit } from '../../services/audit.js';
import type { Actor } from './service.js';

/**
 * Per-job file upload + retrieval (P1-19e). Files are written to local disk (a prototype decision —
 * see CLAUDE.md) under a generated, collision-free name, OUTSIDE any webroot, and are never executed.
 * Access is gated by auth + quote ownership (the prototype equivalent of a signed URL).
 *
 * Versioning: re-uploading a file with the same `originalName` on the same quote creates a new row
 * with `version = previousMax + 1`; earlier rows (and their bytes on disk) are preserved.
 *
 * NOTE (AV scanning deferred): a malware scanner would hook in HERE — after the bytes are written to
 * disk and before the row is committed (or quarantine + reject on a positive). Not implemented in the
 * prototype.
 */

/** Allowed upload MIME types (P1-19e). Anything else is rejected with a typed 400. */
const ALLOWED_MIME = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'message/rfc822', // .eml
  'application/vnd.ms-outlook', // .msg
  'application/octet-stream', // some clients send .msg/.docx as this — extension is the fallback gate
]);

const ALLOWED_EXT = new Set<string>([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.csv', '.docx', '.doc', '.eml', '.msg',
]);

/** Strip any path components / unsafe characters from a client-supplied filename. */
const sanitizeName = (name: string): string => {
  const base = basename(name).replace(/[/\\]/g, '');
  // Keep it readable but safe: collapse anything unusual to underscores.
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'upload';
};

const isAllowed = (mimeType: string, originalName: string): boolean =>
  ALLOWED_MIME.has(mimeType) && ALLOWED_EXT.has(extname(originalName).toLowerCase());

export interface DocumentDto {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  uploadedBy: { id: string; name: string } | null;
  createdAt: string;
}

const toDto = (d: {
  id: bigint;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  createdAt: Date;
  uploadedBy?: { id: bigint; name: string } | null;
}): DocumentDto => ({
  id: d.id.toString(),
  originalName: d.originalName,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  version: d.version,
  uploadedBy: d.uploadedBy ? { id: d.uploadedBy.id.toString(), name: d.uploadedBy.name } : null,
  createdAt: d.createdAt.toISOString(),
});

/**
 * Persist an uploaded multipart file for a quote, then create + audit the document row.
 * Validates mime/extension; size is enforced by the multipart `fileSize` limit (truncation throws).
 */
export const saveDocument = async (
  actor: Actor,
  quoteId: bigint,
  file: MultipartFile,
  uploadDir: string,
): Promise<DocumentDto> => {
  const originalName = sanitizeName(file.filename ?? 'upload');
  const mimeType = file.mimetype;

  if (!isAllowed(mimeType, originalName)) {
    // Drain the stream so the connection doesn't hang, then reject.
    file.file.resume();
    throw new AppError('bad_request', `File type not allowed: ${mimeType} (${extname(originalName) || 'no ext'})`);
  }

  const storedName = `${randomUUID()}${extname(originalName).toLowerCase()}`;
  const destPath = join(uploadDir, storedName);

  try {
    await pipeline(file.file, createWriteStream(destPath));
  } catch (err) {
    await unlink(destPath).catch(() => {});
    throw err;
  }

  // @fastify/multipart truncates (does not throw mid-stream) when fileSize is exceeded.
  if (file.file.truncated) {
    await unlink(destPath).catch(() => {});
    throw new AppError('bad_request', 'File exceeds the 25 MB upload limit');
  }

  // TODO(AV): run a malware scan on `destPath` here before committing the row; quarantine + reject
  // on a positive result. Deferred in the prototype.

  const sizeBytes = file.file.bytesRead;

  return prisma.$transaction(async (tx) => {
    const prev = await tx.quoteDocument.findFirst({
      where: { quoteId, originalName },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (prev?.version ?? 0) + 1;
    const created = await tx.quoteDocument.create({
      data: {
        quoteId,
        originalName,
        storedName,
        mimeType,
        sizeBytes,
        version,
        uploadedById: actor.id,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'create',
      entityTable: 'quote_documents',
      entityId: created.id,
      changes: [{ field: 'document', oldValue: null, newValue: `${originalName} v${version}` }],
    });
    return toDto(created);
  });
};

/** List a quote's documents, newest first. Metadata only (no bytes). */
export const listDocuments = async (quoteId: bigint): Promise<DocumentDto[]> => {
  const rows = await prisma.quoteDocument.findMany({
    where: { quoteId },
    orderBy: { createdAt: 'desc' },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  return rows.map(toDto);
};

export interface DocumentFile {
  path: string;
  originalName: string;
  mimeType: string;
}

/** Resolve a document for download (path + metadata). Throws 404 if it isn't on this quote. */
export const getDocumentFile = async (
  quoteId: bigint,
  docId: bigint,
  uploadDir: string,
): Promise<DocumentFile> => {
  const doc = await prisma.quoteDocument.findFirst({ where: { id: docId, quoteId } });
  if (!doc) throw notFound('Document', docId.toString());
  return { path: join(uploadDir, doc.storedName), originalName: doc.originalName, mimeType: doc.mimeType };
};

/** Delete a document row + best-effort unlink the file on disk; audited. */
export const deleteDocument = async (
  actor: Actor,
  quoteId: bigint,
  docId: bigint,
  uploadDir: string,
): Promise<void> => {
  const doc = await prisma.quoteDocument.findFirst({ where: { id: docId, quoteId } });
  if (!doc) throw notFound('Document', docId.toString());

  await prisma.$transaction(async (tx) => {
    await tx.quoteDocument.delete({ where: { id: docId } });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'delete',
      entityTable: 'quote_documents',
      entityId: docId,
      changes: [{ field: 'document', oldValue: `${doc.originalName} v${doc.version}`, newValue: null }],
    });
  });

  // Best-effort: the row is the source of truth; an orphaned file is harmless.
  await unlink(join(uploadDir, doc.storedName)).catch(() => {});
};
