import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@quotezen/db';
import type { UserRole } from '@quotezen/shared';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { createDraftFromDeal } from './intake.js';

/**
 * Zoho workflow webhook (stage → "ready to quote"): authenticate, acknowledge at once, and build the
 * draft quote in the background — building takes ~1-2 min, far longer than Zoho waits for a reply.
 * Duplicate deliveries are harmless: in-flight deals are skipped here, and the unique zoho_deal_id
 * stops a second quote for an already-quoted deal.
 */

/** Constant-time compare of the shared secret (no early exit that leaks how much matched). */
export const secretMatches = (expected: string, given: string | undefined): boolean => {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const assertWebhookSecret = (config: AppConfig, given: string | undefined): void => {
  if (!config.ZOHO_WEBHOOK_SECRET) {
    throw new AppError('not_configured', 'Zoho webhook is not configured (set ZOHO_WEBHOOK_SECRET in .env)');
  }
  if (!secretMatches(config.ZOHO_WEBHOOK_SECRET, given)) throw new AppError('unauthorized', 'Invalid webhook secret');
};

export interface IntakeEvent {
  dealId: string;
  dealName: string | null;
  source: 'webhook' | 'poll';
  receivedAt: string;
  status: 'processing' | 'created' | 'skipped' | 'failed';
  quoteId?: string;
  message?: string;
}

/** Recent webhook outcomes, newest first — for checking what happened (in memory; resets on restart). */
const recent: IntakeEvent[] = [];
const inFlight = new Set<string>();
const MAX_RECENT = 50;

export const recentIntakeEvents = (): readonly IntakeEvent[] => recent;

const intakeActor = async (config: AppConfig): Promise<{ id: bigint; role: UserRole }> => {
  const user = await prisma.user.findUnique({
    where: { email: config.ZOHO_INTAKE_USER_EMAIL },
    include: { role: true },
  });
  if (!user) throw new AppError('not_configured', `Intake user ${config.ZOHO_INTAKE_USER_EMAIL} not found`);
  return { id: user.id, role: user.role.name as UserRole };
};

type Log = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/** Queue a deal for draft-quote creation. Returns false when it is already being processed. */
export const enqueueDeal = (
  config: AppConfig,
  dealId: string,
  dealName: string | null,
  log: Log,
  source: IntakeEvent['source'] = 'webhook',
  onDone?: (status: IntakeEvent['status']) => void,
): boolean => {
  if (inFlight.has(dealId)) return false;
  inFlight.add(dealId);
  const event: IntakeEvent = { dealId, dealName, source, receivedAt: new Date().toISOString(), status: 'processing' };
  recent.unshift(event);
  recent.length = Math.min(recent.length, MAX_RECENT);

  setImmediate(() => {
    void (async () => {
      try {
        const result = await createDraftFromDeal(config, await intakeActor(config), dealId);
        Object.assign(event, { status: 'created', quoteId: result.quoteId });
        log.info({ dealId, quoteId: result.quoteId }, 'zoho intake: draft quote created');
      } catch (err) {
        // Expected outcomes (already quoted, nothing to read, not a quote request) are "skipped".
        const expected = err instanceof AppError && ['conflict', 'bad_request', 'not_found'].includes(err.code);
        const quoteId = (err as AppError).details && ((err as AppError).details as { quoteId?: string }).quoteId;
        Object.assign(event, {
          status: expected ? 'skipped' : 'failed',
          message: err instanceof Error ? err.message : String(err),
          ...(quoteId ? { quoteId } : {}),
        });
        log.error({ dealId, err: event.message }, `zoho intake: ${event.status}`);
      } finally {
        inFlight.delete(dealId);
        onDone?.(event.status);
      }
    })();
  });
  return true;
};
