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
    const client = await prisma.client.findUnique({ where: { id } });
    if (!client) throw notFound('Client', id.toString());

    const settings = await prisma.setting.findMany();
    const byKey = new Map(settings.map((s) => [s.key, Number(s.value)]));
    const marginFloor = byKey.get('margin_floor') ?? 0;

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
      preferredProductFamily: field(client.preferredProductFamily, Boolean(client.preferredProductFamily)),
      preferredPitchMm: field(
        client.preferredPitchMm != null ? Number(client.preferredPitchMm) : null,
        client.preferredPitchMm != null,
      ),
      excludedComponents: excluded,
    };
  });
};
