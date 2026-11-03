import { prisma } from '@quotezen/db';
import { createQuoteSchema, ledScreenSchema } from '@quotezen/shared';
import type { AppConfig } from '../../config.js';
import { AppError, conflict } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { recordAdminAudit, recordAudit } from '../../services/audit.js';
import { extractIntake, mimeFromFileName, type IntakeDocument, type IntakeExtraction } from '../ai/extract.js';
import { saveDocumentBuffer } from '../quotes/documents.js';
import { addLedScreen, configureForQuote } from '../quotes/screens.js';
import { createQuote, type Actor } from '../quotes/service.js';
import { downloadDealAttachment, getDeal, listDealAttachments, zohoSettings, type ZohoDeal } from './client.js';

/**
 * Phase 2 intake: Zoho deal → customer files → AI-proposed values → DRAFT quote.
 * The AI only proposes; the draft is built with the same configurator + pricing an estimator uses,
 * and nothing leaves the building until the quote is reviewed and approved.
 */

/** 20 MB per file: Gemini's Files API takes more, but customer briefs are far smaller. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface DealReading {
  deal: ZohoDeal;
  docs: IntakeDocument[];
  skipped: { fileName: string; reason: string }[];
  extraction: IntakeExtraction;
  ai: { model: string; inputTokens: number | null; outputTokens: number | null };
}

/** Fetch a deal + its readable attachments from Zoho and let the AI fill the intake form. */
export const readDeal = async (config: AppConfig, dealId: string): Promise<DealReading> => {
  const zoho = zohoSettings(config);
  const deal = await getDeal(zoho, dealId);
  const attachments = await listDealAttachments(zoho, dealId);

  const docs: IntakeDocument[] = [];
  const skipped: { fileName: string; reason: string }[] = [];
  for (const a of attachments) {
    const mimeType = mimeFromFileName(a.File_Name);
    if (!mimeType) {
      skipped.push({ fileName: a.File_Name, reason: 'file type not readable by AI yet' });
      continue;
    }
    if (Number(a.Size) > MAX_FILE_BYTES) {
      skipped.push({ fileName: a.File_Name, reason: 'file larger than 20 MB' });
      continue;
    }
    docs.push({ fileName: a.File_Name, mimeType, data: await downloadDealAttachment(zoho, dealId, a.id) });
  }

  // Nothing for the AI to read → say so instead of spending a (rate-limited) AI call.
  if (docs.length === 0 && !deal.Description) {
    throw new AppError('bad_request', 'This deal has no readable attachments or description to extract from', {
      skipped,
    });
  }

  // The CRM record itself is context too (account/contact names, any description typed by sales).
  const context = [
    `Deal: ${deal.Deal_Name}`,
    deal.Account_Name ? `Account: ${deal.Account_Name.name}` : null,
    deal.Contact_Name ? `Contact: ${deal.Contact_Name.name}` : null,
    deal.Description ? `Description: ${deal.Description}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const { extraction, model, usage } = await extractIntake(config, docs, context);
  return { deal, docs, skipped, extraction, ai: { model, ...usage } };
};

// ── Matching AI text to our reference data ──────────────────────────────────────────────────────

const LEGAL_SUFFIXES = /\b(pty|ltd|limited|inc|incorporated|llc|plc|co|corp|corporation|group holdings)\b/g;

/** "Harbour Retail Pty Ltd" / "harbour retail (Sample)" → "harbour retail" — for duplicate-safe matching. */
export const normalizeClientName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Pick the location whose "City, ST" label matches the AI's city (and state when given). */
export const matchLocationName = (
  locations: readonly { id: bigint; name: string }[],
  city: string | null,
  state: string | null,
): { id: bigint; name: string } | null => {
  if (!city) return null;
  const c = city.trim().toLowerCase();
  const s = state?.trim().toLowerCase() ?? null;
  const byCity = locations.filter((l) => l.name.split(',')[0]?.trim().toLowerCase() === c);
  if (byCity.length <= 1 || !s) return byCity[0] ?? null;
  return byCity.find((l) => l.name.split(',')[1]?.trim().toLowerCase() === s) ?? byCity[0] ?? null;
};

/** Existing client by normalized name, else auto-create one (audited like an admin create). */
const resolveClient = async (
  actor: Actor,
  name: string,
): Promise<{ id: bigint; name: string; created: boolean }> => {
  const key = normalizeClientName(name);
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const existing = clients.find((c) => normalizeClientName(c.name) === key);
  if (existing) return { ...existing, created: false };

  // Same default as an admin create: a new client inherits the system default discount (U0).
  const setting = await prisma.setting.findUnique({ where: { key: 'default_client_discount_pct' } });
  const discountPct = setting?.value != null ? Number(setting.value) : undefined;
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.client.create({ data: { name: name.trim().slice(0, 200), discountPct } });
    await recordAdminAudit(tx, {
      userId: actor.id,
      tableName: 'clients',
      recordId: row.id.toString(),
      action: 'create',
      changes: { name: row.name, source: 'zoho_ai_intake' },
    });
    return row;
  });
  return { id: created.id, name: created.name, created: true };
};

// ── Draft quote creation ────────────────────────────────────────────────────────────────────────

export type ScreenOutcome =
  | { name: string; status: 'added'; screenId: string; product: string; qty: number }
  | { name: string; status: 'needs_estimator'; reason: string };

/** Human-readable intake summary for the quote's project notes (capped at the 2000-char column). */
export const buildIntakeNotes = (
  dealName: string,
  extraction: IntakeExtraction,
  outcomes: readonly ScreenOutcome[],
  model: string,
): string => {
  const lines = [
    `Created automatically from Zoho deal "${dealName}" — values proposed by AI (${model}); please review.`,
    extraction.installDeadlineText ? `Install deadline: ${extraction.installDeadlineText}` : null,
    extraction.missingInfo.length ? `Missing info: ${extraction.missingInfo.join('; ')}` : null,
    extraction.conflicts.length ? `Conflicts: ${extraction.conflicts.join('; ')}` : null,
    ...outcomes.filter((o) => o.status === 'needs_estimator').map((o) => `Screen "${o.name}" needs the estimator: ${o.reason}`),
  ].filter(Boolean);
  return lines.join('\n').slice(0, 2000);
};

const ledOutcome = async (
  actor: Actor,
  quoteId: bigint,
  s: IntakeExtraction['screens'][number],
  name: string,
): Promise<ScreenOutcome> => {
  if (s.screenType !== 'LED') {
    return {
      name,
      status: 'needs_estimator',
      reason: s.screenType === 'LCD' ? 'LCD display selection is not automated yet' : 'LED or LCD not decided',
    };
  }
  if (!s.widthMm || !s.heightMm) return { name, status: 'needs_estimator', reason: 'opening size missing' };

  // Same configurator the wizard uses; options[0] is its top-ranked (= "recommended") build.
  const configured = await configureForQuote(quoteId, {
    desiredWidthMm: s.widthMm,
    desiredHeightMm: s.heightMm,
    allowRotation: s.allowRotation ?? true,
    environment: s.environment ?? undefined,
    // The nearest viewer sets the finest pitch needed.
    viewingDistanceM: s.viewingDistanceMinM ?? undefined,
  });
  const top = configured.options[0];
  if (!top) {
    return { name, status: 'needs_estimator', reason: configured.reasons.join(' ') || 'no product fits this opening' };
  }

  // Like the wizard: pre-fill the pixel-sized controller (estimator can change it).
  const input = parse(ledScreenSchema, {
    screenName: name,
    ledProductId: top.productId,
    desiredWidthMm: s.widthMm,
    desiredHeightMm: s.heightMm,
    qty: s.quantity ?? 1,
    rotateCabinets: top.rotated,
    orientation: s.orientation === 'portrait' ? 'Portrait' : s.orientation === 'landscape' ? 'Landscape' : undefined,
    components: top.suggestedControllerId
      ? [{ componentType: 'controller', controllerId: top.suggestedControllerId, qty: Math.max(1, top.controllerCount ?? 1) }]
      : [],
  });
  const screen = await addLedScreen(actor.id, quoteId, input);
  return { name, status: 'added', screenId: screen.id.toString(), product: top.model, qty: input.qty };
};

/**
 * `ZOHO-<dealId>`, or `-2`, `-3`… when taken — an earlier quote for the deal may have been unlinked
 * (archived/re-quoted) but keeps its job reference, which is unique.
 */
const freeJobReference = async (base: string): Promise<string> => {
  const taken = new Set(
    (
      await prisma.quote.findMany({ where: { jobReference: { startsWith: base } }, select: { jobReference: true } })
    ).map((q) => q.jobReference),
  );
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

export const createDraftFromDeal = async (config: AppConfig, actor: Actor, dealId: string) => {
  // One deal → one quote. Re-reading a deal into an existing quote (new version) comes later.
  const existing = await prisma.quote.findUnique({ where: { zohoDealId: dealId }, select: { id: true } });
  if (existing) {
    throw new AppError('conflict', `A quote already exists for this Zoho deal`, { quoteId: existing.id.toString() });
  }

  const reading = await readDeal(config, dealId);
  const { deal, extraction } = reading;
  if (!extraction.isQuoteRequest) {
    throw new AppError('bad_request', 'The AI did not find a quote request in this deal', { extraction });
  }

  const clientName = extraction.client ?? deal.Account_Name?.name ?? null;
  const client = clientName ? await resolveClient(actor, clientName) : null;
  const locations = await prisma.location.findMany({ select: { id: true, name: true } });
  const location = matchLocationName(locations, extraction.city, extraction.state);

  const input = parse(createQuoteSchema, {
    jobReference: await freeJobReference(`ZOHO-${dealId}`),
    clientId: client ? Number(client.id) : undefined,
    locationId: location ? Number(location.id) : undefined,
    currencyCode: 'AUD',
    endCustomer: clientName ?? undefined,
    siteAddress: [extraction.siteArea, extraction.city, extraction.state].filter(Boolean).join(', ') || undefined,
    budgetAud: extraction.budgetAud ?? undefined,
    windowFacing: extraction.screens.some((s) => s.windowFacing) ? true : undefined,
  });
  let quote;
  try {
    quote = await createQuote(actor.id, input, actor.role, {
      zohoDealId: dealId,
      aiIntake: { ...extraction, model: reading.ai.model, dealName: deal.Deal_Name },
    });
  } catch (err) {
    // Two triggers for the same deal at once: the unique zoho_deal_id lets only one through.
    if ((err as { code?: string }).code === 'P2002') throw conflict('A quote already exists for this Zoho deal');
    throw err;
  }

  // Keep the customer's original files on the quote (Documents panel) — Google's copy expires in 48 h.
  const documents = [];
  for (const d of reading.docs) {
    documents.push(await saveDocumentBuffer(actor, quote.id, d.fileName, d.mimeType, d.data, config.UPLOAD_DIR));
  }

  // Screens: one at a time; a screen that can't be built automatically is listed, never guessed.
  const outcomes: ScreenOutcome[] = [];
  for (const [i, s] of extraction.screens.entries()) {
    const name = s.name ?? `Screen ${i + 1}`;
    try {
      outcomes.push(await ledOutcome(actor, quote.id, s, name));
    } catch (err) {
      outcomes.push({ name, status: 'needs_estimator', reason: err instanceof Error ? err.message : 'could not be added' });
    }
  }

  const notes = buildIntakeNotes(deal.Deal_Name, extraction, outcomes, reading.ai.model);
  await prisma.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id: quote.id },
      data: { projectNotes: notes, updatedById: actor.id, lockVersion: { increment: 1 } },
    });
    await recordAudit(tx, {
      quoteId: quote.id,
      userId: actor.id,
      action: 'update',
      entityTable: 'quotes',
      entityId: quote.id,
      changes: [{ field: 'project_notes', oldValue: null, newValue: notes }],
    });
  });

  return {
    quoteId: quote.id.toString(),
    jobReference: quote.jobReference,
    client: client ? { id: client.id.toString(), name: client.name, created: client.created } : null,
    location: location?.name ?? null,
    screens: outcomes,
    documents: documents.map((d) => d.originalName),
    skipped: reading.skipped,
    missingInfo: extraction.missingInfo,
    conflicts: extraction.conflicts,
    ai: reading.ai,
  };
};
