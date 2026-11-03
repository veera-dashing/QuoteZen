import { prisma } from '@quotezen/db';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { listDealsInStage, zohoSettings } from './client.js';
import { enqueueDeal } from './webhook.js';

/**
 * Polling fallback for the Zoho webhook (off unless ZOHO_POLL_INTERVAL_SEC > 0). Each tick: deals in
 * the intake stage → minus those already quoted → queued through the same path as the webhook.
 *
 * AI quota guard: a deal that was skipped (no files, not a quote request…) is not re-read every tick —
 * only once it has been edited in Zoho (Modified_Time changes). Failed attempts (Zoho/AI outage) are
 * retried on the next tick.
 */

/** dealId → the Modified_Time we last attempted it at. */
const attempted = new Map<string, string | null>();

/** Pure selection step: which of the stage's deals should be queued this tick. */
export const dealsToQueue = (
  deals: readonly { id: string; Modified_Time: string | null }[],
  quotedDealIds: ReadonlySet<string>,
  attemptedAt: ReadonlyMap<string, string | null>,
): string[] =>
  deals
    .filter((d) => !quotedDealIds.has(d.id))
    .filter((d) => !attemptedAt.has(d.id) || attemptedAt.get(d.id) !== d.Modified_Time)
    .map((d) => d.id);

export const pollOnce = async (config: AppConfig, log: FastifyInstance['log']): Promise<number> => {
  const deals = await listDealsInStage(zohoSettings(config), config.ZOHO_INTAKE_STAGE);
  if (deals.length === 0) return 0;

  const quoted = await prisma.quote.findMany({
    where: { zohoDealId: { in: deals.map((d) => d.id) } },
    select: { zohoDealId: true },
  });
  const quotedIds = new Set(quoted.map((q) => q.zohoDealId).filter((id): id is string => id !== null));
  const ids = dealsToQueue(deals, quotedIds, attempted);

  for (const id of ids) {
    const deal = deals.find((d) => d.id === id)!;
    attempted.set(id, deal.Modified_Time);
    enqueueDeal(config, id, deal.Deal_Name, log, 'poll', (status) => {
      if (status === 'failed') attempted.delete(id); // transient — try again next tick
    });
  }
  return ids.length;
};

/** Start the poller with the app (if enabled) and stop it on close. Ticks never overlap. */
export const registerZohoPoller = (app: FastifyInstance, config: AppConfig): void => {
  const everyMs = config.ZOHO_POLL_INTERVAL_SEC * 1000;
  if (everyMs === 0) return;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const queued = await pollOnce(config, app.log);
      if (queued > 0) app.log.info({ queued, stage: config.ZOHO_INTAKE_STAGE }, 'zoho poll: deals queued');
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'zoho poll failed');
    } finally {
      running = false;
    }
  };

  app.addHook('onReady', async () => {
    app.log.info({ everySec: config.ZOHO_POLL_INTERVAL_SEC, stage: config.ZOHO_INTAKE_STAGE }, 'zoho poller started');
    timer = setInterval(() => void tick(), everyMs);
    void tick();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
};
