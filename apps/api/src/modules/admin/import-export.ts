/**
 * Bulk import / export for any admin table (P1-06.4 / P1-06.5).
 *
 *   • Export  — GET  /admin/:resource/export        → CSV of all rows (admin only; cost data, BR-081).
 *   • Preview — POST /admin/:resource/import/preview → validate without writing, return a report.
 *   • Confirm — POST /admin/:resource/import         → all-or-nothing upsert in one $transaction.
 *
 * Validation reuses the SAME registry-derived Zod coercion as the generic CRUD router
 * (`buildSchemas` / `fieldSchema`) so import behaves identically to a manual add/edit. Rows are
 * upserted: a present, existing `id` ⇒ update; otherwise ⇒ create. If ANY row is invalid the
 * confirm aborts (422) and nothing is written; a DB constraint failure (e.g. duplicate unique key)
 * rolls the whole transaction back and names the offending row.
 */
import { z } from 'zod';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import { prisma } from '@quotezen/db';
import { AppError, notFound } from '../../errors.js';
import { recordAdminAudit } from '../../services/audit.js';
import { TABLE_BY_RESOURCE, type TableDef } from './registry.js';
import { buildSchemas, delegate } from './routes.js';

/** A row error in the validation report (1-based row index as seen in the file/payload). */
export interface RowError {
  row: number;
  messages: string[];
}

/** Dry-run report returned by the preview endpoint (and embedded in a confirm 422). */
export interface ImportReport {
  total: number;
  valid: number;
  invalid: number;
  willCreate: number;
  willUpdate: number;
  errors: RowError[];
}

/** A validated row ready to apply: data plus the resolved upsert target. */
interface PreparedRow {
  id: bigint | null;
  data: Record<string, unknown>;
}

const idColumn = z.coerce.bigint();

/**
 * Parse the request payload into an array of raw string-keyed rows. Accepts either a multipart CSV
 * file (field `file`) or a JSON body `{ rows: [...] }`. Empty CSV cells become `undefined` so they
 * are treated as "not provided" (and skipped for optional fields / partial updates).
 */
const readRows = async (request: FastifyRequest): Promise<Array<Record<string, unknown>>> => {
  if (request.isMultipart()) {
    const file: MultipartFile | undefined = await request.file();
    if (!file) throw new AppError('bad_request', 'No CSV file provided in the multipart request');
    const buf = await file.toBuffer();
    let records: Array<Record<string, string>>;
    try {
      records = parseCsv(buf, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (err) {
      throw new AppError('bad_request', `CSV parse failed: ${(err as Error).message}`);
    }
    // Treat empty strings as absent so optional fields / partial updates work.
    return records.map((rec) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = v === '' ? undefined : v;
      return out;
    });
  }
  const body = z.object({ rows: z.array(z.record(z.unknown())) }).safeParse(request.body);
  if (!body.success) {
    throw new AppError('bad_request', 'Provide a multipart CSV file or a JSON body { rows: [...] }');
  }
  return body.data.rows;
};

/**
 * Validate every row against the table schema and resolve its upsert target, accumulating a report.
 * Required fields are honoured only on CREATE (no id); UPDATE rows (existing id) validate the
 * provided subset (partial) — matching the PATCH semantics of the generic CRUD.
 */
const prepare = async (
  def: TableDef,
  rawRows: Array<Record<string, unknown>>,
): Promise<{ report: ImportReport; prepared: PreparedRow[] }> => {
  const { createSchema, updateSchema } = buildSchemas(def);
  const fieldNames = new Set(def.fields.map((f) => f.name));
  // Pre-resolve which ids exist so we can classify create vs update without N queries.
  const ids: bigint[] = [];
  for (const raw of rawRows) {
    const rawId = (raw as { id?: unknown }).id;
    if (rawId === undefined || rawId === null || rawId === '') continue;
    const r = idColumn.safeParse(rawId);
    if (r.success) ids.push(r.data);
  }
  const existing = ids.length
    ? new Set<string>(
        (await delegate(def).findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
          (r: { id: bigint }) => r.id.toString(),
        ),
      )
    : new Set<string>();

  const errors: RowError[] = [];
  const prepared: PreparedRow[] = [];
  let willCreate = 0;
  let willUpdate = 0;

  rawRows.forEach((raw, i) => {
    const rowNo = i + 1;
    const messages: string[] = [];

    // Unknown columns (not id, not a known field) are rejected — keeps imports honest.
    for (const key of Object.keys(raw)) {
      if (key !== 'id' && !fieldNames.has(key)) messages.push(`Unknown column "${key}"`);
    }

    const rawId = (raw as { id?: unknown }).id;
    let id: bigint | null = null;
    if (rawId !== undefined && rawId !== null && rawId !== '') {
      const r = idColumn.safeParse(rawId);
      if (!r.success) messages.push('id: must be an integer');
      else id = r.data;
    }

    // Strip id + undefined values; validate the remaining provided fields.
    const fieldData: Record<string, unknown> = {};
    for (const fld of def.fields) {
      const v = (raw as Record<string, unknown>)[fld.name];
      if (v !== undefined) fieldData[fld.name] = v;
    }

    const isUpdate = id !== null && existing.has(id.toString());
    if (id !== null && !existing.has(id.toString())) {
      messages.push(`id ${id.toString()} does not exist (use a blank id to create)`);
    }

    const schema = isUpdate ? updateSchema : createSchema;
    const result = schema.safeParse(fieldData);
    if (!result.success) {
      for (const issue of result.error.issues) {
        messages.push(`${issue.path.join('.') || '(row)'}: ${issue.message}`);
      }
    }

    if (messages.length > 0) {
      errors.push({ row: rowNo, messages });
      return;
    }
    if (isUpdate) willUpdate += 1;
    else willCreate += 1;
    prepared.push({ id: isUpdate ? id : null, data: result.success ? result.data : fieldData });
  });

  const report: ImportReport = {
    total: rawRows.length,
    valid: prepared.length,
    invalid: errors.length,
    willCreate,
    willUpdate,
    errors,
  };
  return { report, prepared };
};

export const importExportRoutes = async (app: FastifyInstance): Promise<void> => {
  // Export can contain cost data (BR-081) → admin only. Import mutates the catalog → admin only.
  const adminOnly = { preHandler: [app.requireRole('admin')] };

  const resolve = (resource: string): TableDef => {
    const def = TABLE_BY_RESOURCE.get(resource);
    if (!def) throw notFound('Resource', resource);
    return def;
  };

  // ── Export: CSV of every row (columns = writable fields + id). ──
  app.get<{ Params: { resource: string } }>('/admin/:resource/export', adminOnly, async (request, reply) => {
    const def = resolve(request.params.resource);
    const columns = ['id', ...def.fields.map((f) => f.name)];
    const rows: Array<Record<string, unknown>> = await delegate(def).findMany({ orderBy: { id: 'asc' } });
    const records = rows.map((row) => {
      const out: Record<string, string> = {};
      for (const col of columns) {
        const v = (row as Record<string, unknown>)[col];
        out[col] = v === null || v === undefined ? '' : String(v); // Decimal/BigInt → numeric string
      }
      return out;
    });
    const csv = stringifyCsv(records, { header: true, columns });
    // Record WHO exported WHAT (cost-bearing tables are admin-only — BR-081).
    await recordAdminAudit(prisma, {
      userId: BigInt(request.user.id),
      tableName: def.resource,
      recordId: null,
      action: 'export',
      changes: { rows: rows.length },
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${def.resource}.csv"`)
      .send(csv);
  });

  // ── Import dry-run: validate, classify, never write. ──
  app.post<{ Params: { resource: string } }>('/admin/:resource/import/preview', adminOnly, async (request) => {
    const def = resolve(request.params.resource);
    if (def.readonly) throw new AppError('forbidden', `${def.label} is read-only`);
    const rawRows = await readRows(request);
    const { report } = await prepare(def, rawRows);
    return report;
  });

  // ── Import confirm: all-or-nothing upsert in a single transaction. ──
  app.post<{ Params: { resource: string } }>('/admin/:resource/import', adminOnly, async (request, reply) => {
    const def = resolve(request.params.resource);
    if (def.readonly) throw new AppError('forbidden', `${def.label} is read-only`);
    const rawRows = await readRows(request);
    if (rawRows.length === 0) throw new AppError('bad_request', 'No rows to import');

    const { report, prepared } = await prepare(def, rawRows);
    if (report.invalid > 0) {
      // Abort before touching the DB; hand back the full report so the caller can fix and retry.
      throw new AppError('validation_error', 'Import rejected: one or more rows are invalid', report);
    }

    let created = 0;
    let updated = 0;
    try {
      await prisma.$transaction(async (tx) => {
        const txDelegate = (tx as Record<string, unknown>)[def.model] as {
          create: (a: unknown) => Promise<unknown>;
          update: (a: unknown) => Promise<unknown>;
        };
        for (const row of prepared) {
          if (row.id !== null) {
            await txDelegate.update({ where: { id: row.id }, data: row.data });
            updated += 1;
          } else {
            await txDelegate.create({ data: row.data });
            created += 1;
          }
        }
      });
    } catch (err) {
      // A constraint (e.g. duplicate unique key, P2002) rolled the whole transaction back.
      const e = err as { code?: string; meta?: { target?: unknown } };
      const failedAt = created + updated + 1; // 1-based position within the applied sequence
      if (e.code === 'P2002') {
        const target = Array.isArray(e.meta?.target) ? (e.meta?.target as string[]).join(', ') : 'unique field';
        throw new AppError('conflict', `Row ${failedAt}: duplicate value for ${target} — import rolled back`);
      }
      throw new AppError('bad_request', `Row ${failedAt}: import failed and was rolled back — ${(err as Error).message}`);
    }

    return reply.send({ created, updated });
  });
};
