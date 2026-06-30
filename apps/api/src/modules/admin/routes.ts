import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { AppError, notFound } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { adminSnapshot, adminUpdateDiff, recordAdminAudit } from '../../services/audit.js';
import { TABLE_BY_RESOURCE, TABLES, type FieldDef, type TableDef } from './registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const delegate = (def: TableDef): any => (prisma as Record<string, any>)[def.model];

/** True when a table carries the deprecate-not-delete flag (P1-08.4 / P1-11.4). */
const hasDeprecated = (def: TableDef): boolean => def.fields.some((field) => field.name === 'deprecated');

/** Prisma foreign-key constraint violation — the row is referenced (e.g. by a saved quote). */
const isForeignKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2003';

/** Zod validator for one field. */
export const fieldSchema = (field: FieldDef): z.ZodTypeAny => {
  switch (field.type) {
    case 'int':
      return z.coerce.number().int();
    case 'decimal':
      return z.coerce.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.coerce.date();
    case 'enum':
      return z.enum([...(field.options ?? [])] as [string, ...string[]]);
    case 'text':
    case 'string':
    default:
      return z.string().trim().min(1);
  }
};

/** Build create (required honoured) and update (all optional) schemas for a table. */
export const buildSchemas = (def: TableDef) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of def.fields) {
    const base = fieldSchema(field);
    shape[field.name] = field.required ? base : base.nullish();
  }
  const createSchema = z.object(shape).strict();
  const updateSchema = createSchema.partial();
  return { createSchema, updateSchema };
};

const idParam = z.object({ id: z.coerce.bigint() });
const listQuery = z.object({
  q: z.string().trim().optional(),
  take: z.coerce.number().int().min(1).max(500).default(100),
  skip: z.coerce.number().int().min(0).default(0),
  // P1-11.4: NEW-quote pickers pass activeOnly=true to hide deprecated catalog rows. Default
  // (omitted) returns ALL rows so the admin management grid can still see + un-deprecate them.
  activeOnly: z.coerce.boolean().optional(),
});

export const adminRoutes = async (app: FastifyInstance): Promise<void> => {
  const read = { preHandler: [app.authenticate] };
  const write = { preHandler: [app.requireRole('admin', 'sales')] };

  // Registry metadata for the UI (columns, field types, groups).
  app.get('/admin/_meta', read, () => ({ tables: TABLES }));

  const resolve = (resource: string): TableDef => {
    const def = TABLE_BY_RESOURCE.get(resource);
    if (!def) throw notFound('Resource', resource);
    return def;
  };

  // List with optional search + pagination.
  app.get<{ Params: { resource: string }; Querystring: Record<string, string> }>(
    '/admin/:resource',
    read,
    async (request) => {
      const def = resolve(request.params.resource);
      const { q, take, skip, activeOnly } = parse(listQuery, request.query);
      const conditions: Record<string, unknown>[] = [];
      if (q && def.searchFields.length > 0) {
        conditions.push({ OR: def.searchFields.map((field) => ({ [field]: { contains: q, mode: 'insensitive' } })) });
      }
      if (activeOnly && hasDeprecated(def)) conditions.push({ deprecated: false });
      const where = conditions.length > 0 ? { AND: conditions } : undefined;
      const [rows, total] = await Promise.all([
        delegate(def).findMany({ where, take, skip, orderBy: { id: 'asc' } }),
        delegate(def).count({ where }),
      ]);
      return { rows, total, take, skip };
    },
  );

  app.get<{ Params: { resource: string; id: string } }>('/admin/:resource/:id', read, async (request) => {
    const def = resolve(request.params.resource);
    const { id } = parse(idParam, request.params);
    const row = await delegate(def).findUnique({ where: { id } });
    if (!row) throw notFound(def.label, id.toString());
    return row;
  });

  app.post<{ Params: { resource: string } }>('/admin/:resource', write, async (request, reply) => {
    const def = resolve(request.params.resource);
    if (def.readonly) throw new AppError('forbidden', `${def.label} is read-only`);
    const { createSchema } = buildSchemas(def);
    const data = parse(createSchema, request.body);
    const fieldNames = def.fields.map((fld) => fld.name);
    // Create + audit in one transaction — a sensitive table is never mutated without a trail.
    const row = await prisma.$transaction(async (tx) => {
      const created = await (tx as Record<string, any>)[def.model].create({ data });
      await recordAdminAudit(tx, {
        userId: BigInt(request.user.id),
        tableName: def.resource,
        recordId: created.id?.toString() ?? null,
        action: 'create',
        changes: adminSnapshot(created as Record<string, unknown>, fieldNames),
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { resource: string; id: string } }>('/admin/:resource/:id', write, async (request) => {
    const def = resolve(request.params.resource);
    if (def.readonly) throw new AppError('forbidden', `${def.label} is read-only`);
    const { id } = parse(idParam, request.params);
    const { updateSchema } = buildSchemas(def);
    const data = parse(updateSchema, request.body);
    const fieldNames = def.fields.map((fld) => fld.name);
    try {
      return await prisma.$transaction(async (tx) => {
        const txDelegate = (tx as Record<string, any>)[def.model];
        const before = await txDelegate.findUnique({ where: { id } });
        if (!before) throw notFound(def.label, id.toString());
        const after = await txDelegate.update({ where: { id }, data });
        await recordAdminAudit(tx, {
          userId: BigInt(request.user.id),
          tableName: def.resource,
          recordId: id.toString(),
          action: 'update',
          changes: adminUpdateDiff(before as Record<string, unknown>, after as Record<string, unknown>, fieldNames),
        });
        return after;
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw notFound(def.label, id.toString());
    }
  });

  app.delete<{ Params: { resource: string; id: string } }>('/admin/:resource/:id', write, async (request, reply) => {
    const def = resolve(request.params.resource);
    if (def.readonly) throw new AppError('forbidden', `${def.label} is read-only`);
    const { id } = parse(idParam, request.params);
    const fieldNames = def.fields.map((fld) => fld.name);
    try {
      await prisma.$transaction(async (tx) => {
        const txDelegate = (tx as Record<string, any>)[def.model];
        const before = await txDelegate.findUnique({ where: { id } });
        if (!before) throw notFound(def.label, id.toString());
        await txDelegate.delete({ where: { id } });
        await recordAdminAudit(tx, {
          userId: BigInt(request.user.id),
          tableName: def.resource,
          recordId: id.toString(),
          action: 'delete',
          changes: adminSnapshot(before as Record<string, unknown>, fieldNames),
        });
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Deprecate-not-delete (P1-08.4 / P1-11.4): a hard delete blocked by a FK from a saved quote
      // shouldn't fail — the row must be retained for old quotes but hidden from new ones. If the
      // table carries a `deprecated` flag, mark it deprecated (audited) and report success.
      if (isForeignKeyError(err) && hasDeprecated(def)) {
        await prisma.$transaction(async (tx) => {
          const txDelegate = (tx as Record<string, any>)[def.model];
          const before = await txDelegate.findUnique({ where: { id } });
          if (!before) throw notFound(def.label, id.toString());
          const after = await txDelegate.update({ where: { id }, data: { deprecated: true } });
          // Audited as an 'update' (the admin-audit action union); a `_reason` note records that
          // this update came from a blocked delete, so the trail reads as a deprecation.
          await recordAdminAudit(tx, {
            userId: BigInt(request.user.id),
            tableName: def.resource,
            recordId: id.toString(),
            action: 'update',
            changes: {
              ...adminUpdateDiff(before as Record<string, unknown>, after as Record<string, unknown>, ['deprecated']),
              _reason: 'deprecated (delete blocked — referenced by existing quotes)',
            },
          });
        });
        return reply.code(200).send({
          deprecated: true,
          message: 'Referenced by existing quotes — deprecated instead of deleted.',
        });
      }
      throw notFound(def.label, id.toString());
    }
    return reply.code(204).send();
  });
};
