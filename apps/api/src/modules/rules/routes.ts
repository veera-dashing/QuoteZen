import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { notFound } from '../../errors.js';
import { parse } from '../../lib/validate.js';

/**
 * Rule resolution (P1-10.3): merge global defaults with per-client overrides and report which value
 * wins. The margin floor is a guardrail — a client margin below the floor does NOT lower the effective
 * margin (guardrail wins, P1-10.4).
 */
const idParam = z.object({ id: z.coerce.bigint() });

export const ruleRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/rules/client/:id/effective', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = parse(idParam, request.params);
    // Z6: load the client's rule-bearing tier so discount/freight can layer global→tier→client.
    const client = await prisma.client.findUnique({ where: { id }, include: { clientTier: true } });
    if (!client) throw notFound('Client', id.toString());
    const tier = client.clientTier;

    const settings = await prisma.setting.findMany();
    const byKey = new Map(settings.map((s) => [s.key, Number(s.value)]));
    const marginFloor = byKey.get('margin_floor') ?? 0;
    const defaultDiscount = byKey.get('default_client_discount_pct') ?? 0;

    const clientMargin = client.defaultMargin != null ? Number(client.defaultMargin) : null;
    const belowFloor = clientMargin != null && clientMargin < marginFloor;
    const excluded = (client.excludedComponents ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const field = <T,>(value: T | null, override: boolean) => ({
      value,
      source: override ? ('client' as const) : ('global' as const),
      overridesGlobal: override,
    });

    return {
      clientId: id.toString(),
      client: client.name,
      margin: {
        ...field(clientMargin ?? marginFloor, clientMargin != null),
        floor: marginFloor,
        belowFloor,
        // Guardrail wins: a below-floor client margin is clamped up to the floor.
        effective: belowFloor ? marginFloor : (clientMargin ?? marginFloor),
      },
      // Client commercial discount (U3, layered by Z6): client override → TIER default → system
      // default. Quote-level override is resolved per-quote at pricing time and is not a client-rule
      // concept.
      discount: (() => {
        const hasClient = client.discountPct != null;
        const tierPct = tier?.defaultDiscountPct != null ? Number(tier.defaultDiscountPct) : null;
        const source = hasClient ? ('client' as const) : tierPct != null ? ('tier' as const) : ('system' as const);
        const value = hasClient ? Number(client.discountPct) : tierPct != null ? tierPct : defaultDiscount;
        return {
          value,
          source,
          overridesGlobal: hasClient || tierPct != null,
          tierDefault: tierPct,
          systemDefault: defaultDiscount,
        };
      })(),
      // Preferred freight (Z6): client override → tier preferred freight → none.
      preferredFreight: (() => {
        if (client.preferredFreight) {
          return { value: client.preferredFreight, source: 'client' as const, overridesGlobal: true, tierDefault: tier?.preferredFreight ?? null };
        }
        if (tier?.preferredFreight) {
          return { value: tier.preferredFreight, source: 'tier' as const, overridesGlobal: true, tierDefault: tier.preferredFreight };
        }
        return { value: null, source: 'system' as const, overridesGlobal: false, tierDefault: null };
      })(),
      preferredProductFamily: field(client.preferredProductFamily, Boolean(client.preferredProductFamily)),
      preferredPitchMm: field(
        client.preferredPitchMm != null ? Number(client.preferredPitchMm) : null,
        client.preferredPitchMm != null,
      ),
      excludedComponents: excluded,
      // Z6: the rule-bearing tier block (null when the client has no tier / an unknown tier name).
      tier: tier
        ? {
            name: tier.name,
            description: tier.description,
            installStandard: tier.installStandard,
            preferredFreight: tier.preferredFreight,
            defaultDiscountPct: tier.defaultDiscountPct != null ? Number(tier.defaultDiscountPct) : null,
          }
        : null,
      rulesNote: client.rulesNote ?? null,
    };
  });
};
