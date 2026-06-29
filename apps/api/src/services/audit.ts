import type { Prisma } from '@quotezen/db';
import type { AuditAction } from '@quotezen/shared';

/** A Prisma client or an interactive-transaction client — audit writes must share the txn. */
export type Db = Prisma.TransactionClient;

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

const toStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/**
 * Diff two records over a set of fields, returning only the fields that actually changed.
 * Used so an "update" only logs what the user truly changed.
 */
export const diffFields = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): FieldChange[] => {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = before[field];
    const newValue = after[field];
    if (toStr(oldValue) !== toStr(newValue)) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
};

export interface AuditInput {
  quoteId: bigint;
  userId: bigint;
  action: AuditAction;
  entityTable: string;
  entityId?: bigint;
  changes?: FieldChange[];
}

/**
 * Write audit rows for a quote mutation. Always call inside the same transaction as the change so
 * the quote and its history commit atomically — a quote is never mutated without an audit trail.
 */
export const recordAudit = async (db: Db, input: AuditInput): Promise<void> => {
  const base = {
    quoteId: input.quoteId,
    userId: input.userId,
    action: input.action,
    entityTable: input.entityTable,
    entityId: input.entityId ?? null,
  };

  if (!input.changes || input.changes.length === 0) {
    await db.quoteAuditLog.create({ data: { ...base, fieldName: null, oldValue: null, newValue: null } });
    return;
  }

  await db.quoteAuditLog.createMany({
    data: input.changes.map((c) => ({
      ...base,
      fieldName: c.field,
      oldValue: toStr(c.oldValue),
      newValue: toStr(c.newValue),
    })),
  });
};
