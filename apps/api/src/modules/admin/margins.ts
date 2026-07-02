/**
 * Margins / markups editor (P1-07.2) + admin-audit viewer (P1-06.6 / P1-07.6).
 *
 *   • GET   /admin/margins      → the commercial-multiplier rows of the `settings` table.
 *   • PATCH /admin/margins      → bulk-update their values in ONE transaction; every changed
 *                                 value is written to admin_audit_log.
 *   • GET   /admin/admin-audit  → the reference-table audit feed (admin only).
 *
 * All admin-only — these rows drive every quote's pricing, so they are high-sensitivity.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { AppError } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { recordAdminAudit } from '../../services/audit.js';

/** The settings keys surfaced in the margins editor (markups, margins, and pricing add-ons). */
export const MARGIN_KEYS = [
  'philips_markup',
  'lcd_margin',
  'led_margin',
  'other_equipment_markup',
  'metalwork_markup',
  'service_markup',
  'led_markup',
  'controller_markup',
  'international_shipping_markup',
  'spares_pct',
  'packaging_pct',
  'receiver_card_cost',
  'margin_floor',
  // AA7 — unusual-price flag deviation threshold (advisory; create-on-read defaults to 0.30).
  'unusual_price_deviation_pct',
] as const;

const patchSchema = z
  .object({ values: z.record(z.coerce.number()) })
  .refine((v) => Object.keys(v.values).length > 0, { message: 'no values provided' });

export const marginRoutes = async (app: FastifyInstance): Promise<void> => {
  const adminOnly = { preHandler: [app.requireRole('admin')] };

  // The current multiplier rows, in editor order.
  app.get('/admin/margins', adminOnly, async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [...MARGIN_KEYS] } },
      orderBy: { id: 'asc' },
    });
    const order = new Map<string, number>(MARGIN_KEYS.map((k, i) => [k, i]));
    rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    return rows;
  });

  // Bulk-update all changed values in one transaction; each change is audited.
  app.patch('/admin/margins', adminOnly, async (request) => {
    const { values } = parse(patchSchema, request.body);

    // Reject any key not in the curated margin set — keeps this editor scoped.
    const unknown = Object.keys(values).filter((k) => !(MARGIN_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw new AppError('bad_request', `Unknown margin key(s): ${unknown.join(', ')}`);
    }

    return prisma.$transaction(async (tx) => {
      const current = await tx.setting.findMany({ where: { key: { in: Object.keys(values) } } });
      const byKey = new Map(current.map((s) => [s.key, s]));

      for (const [key, value] of Object.entries(values)) {
        const existing = byKey.get(key);
        if (!existing) throw new AppError('not_found', `Setting "${key}" does not exist`);
        const oldStr = existing.value?.toString() ?? '';
        const newStr = String(value);
        if (oldStr === newStr) continue; // no-op; don't write a noise audit row

        await tx.setting.update({ where: { key }, data: { value } });
        await recordAdminAudit(tx, {
          userId: BigInt(request.user.id),
          tableName: 'settings',
          recordId: existing.id.toString(),
          action: 'update',
          changes: { [key]: { old: oldStr, new: newStr } },
        });
      }

      const updated = await tx.setting.findMany({
        where: { key: { in: [...MARGIN_KEYS] } },
        orderBy: { id: 'asc' },
      });
      return updated;
    });
  });

  // ── Admin-audit viewer (reference-table changes + exports). ──
  const auditQuery = z.object({
    table: z.string().trim().optional(),
    action: z.enum(['create', 'update', 'delete', 'export']).optional(),
    take: z.coerce.number().int().min(1).max(500).default(200),
  });

  app.get('/admin/admin-audit', adminOnly, async (request) => {
    const { table, action, take } = parse(auditQuery, request.query);
    return prisma.adminAuditLog.findMany({
      where: { tableName: table || undefined, action: action || undefined },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { changedAt: 'desc' },
      take,
    });
  });
};
