import { z } from 'zod';
import {
  CURRENCY_CODES,
  LED_COMPONENT_TYPES,
  LICENCE_TIERS,
  ORIENTATIONS,
  QUOTE_STATUSES,
  SCREEN_TYPES,
} from './enums.js';

/** A monetary value accepted from clients: number or numeric string, normalised to a string. */
export const moneySchema = z
  .union([z.number(), z.string()])
  .refine((v) => v !== '' && !Number.isNaN(Number(v)), { message: 'must be a numeric value' })
  .transform((v) => String(v));

export const idSchema = z.coerce.number().int().positive();

/** Positive integer quantity (defaults to 1). */
export const qtySchema = z.coerce.number().int().positive().default(1);

// ─── Quote header ────────────────────────────────────────────────────────────
export const createQuoteSchema = z.object({
  jobReference: z.string().min(1).max(64),
  clientId: idSchema.optional(),
  locationId: idSchema.optional(),
  currencyCode: z.enum(CURRENCY_CODES).default('AUD'),
  resellerMarkup: z.coerce.number().min(0).max(10).default(0),
  validUntil: z.coerce.date().optional(),
  requestedShippingDate: z.coerce.date().optional(),
  /** Viewer users this quote is shared with (they can read only quotes assigned to them). */
  viewerUserIds: z.array(idSchema).optional(),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = createQuoteSchema.partial().extend({
  // Nullable on update so the editor can *clear* a client/location (the service sets the FK to null).
  clientId: idSchema.nullish(),
  locationId: idSchema.nullish(),
  /** Optimistic-locking token from the last read; a mismatch is a 409 conflict (P1-05.2). */
  expectedVersion: z.coerce.number().int().nonnegative().optional(),
});
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(QUOTE_STATUSES),
  reason: z.string().max(500).optional(),
});

/**
 * Query for GET /quotes (the management dashboard, P1-19d.1). `?archived=true` shows the archived
 * view instead of active quotes (P1-05.1); the remaining params are optional server-side filters
 * composed alongside the per-user scope: `status` (one of QUOTE_STATUSES), `clientId`, a `q`
 * case-insensitive substring on jobReference, and a `from`/`to` createdAt date range.
 */
export const listQuotesQuerySchema = z.object({
  archived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
  clientId: idSchema.optional(),
  q: z.string().trim().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;

// ─── LED screen config (the LED-1 questionnaire) ──────────────────────────────
export const ledComponentSchema = z
  .object({
    componentType: z.enum(LED_COMPONENT_TYPES),
    controllerId: idSchema.optional(),
    ledPeripheralId: idSchema.optional(),
    mediaplayerId: idSchema.optional(),
    peripheralId: idSchema.optional(),
    qty: qtySchema,
  })
  .refine(
    (c) =>
      [c.controllerId, c.ledPeripheralId, c.mediaplayerId, c.peripheralId].filter(
        (x) => x !== undefined,
      ).length === 1,
    { message: 'exactly one component reference must be set' },
  );

export const ledScreenSchema = z.object({
  screenName: z.string().max(120).optional(),
  ledProductId: idSchema.optional(),
  qty: qtySchema,
  desiredWidthMm: z.coerce.number().int().positive().optional(),
  desiredHeightMm: z.coerce.number().int().positive().optional(),
  rotateCabinets: z.boolean().default(false),
  orientation: z.enum(ORIENTATIONS).optional(),
  aspectRatioId: idSchema.optional(),
  backCover: z.boolean().default(false),
  frameNote: z.string().max(500).optional(),
  serviceDescriptionSuffix: z.string().max(500).optional(),
  gobId: idSchema.optional(),
  frameId: idSchema.optional(),
  trimId: idSchema.optional(),
  hangingBarId: idSchema.optional(),
  engineeringId: idSchema.optional(),
  installMethodId: idSchema.optional(),
  freightOptionId: idSchema.optional(),
  warrantyId: idSchema.optional(),
  serviceHoursId: idSchema.optional(),
  accessEquipmentId: idSchema.optional(),
  marginOverride: z.coerce.number().min(0).max(0.99).optional(),
  components: z.array(ledComponentSchema).default([]),
});
export type LedScreenInput = z.infer<typeof ledScreenSchema>;

// ─── LCD screen config (the LCD-1 questionnaire) ──────────────────────────────
export const lcdItemSchema = z.object({
  displayId: idSchema.optional(),
  itemType: z.enum(['display', 'mediaplayer', 'bracket', 'install', 'labour', 'location_fee']),
  description: z.string().max(200).optional(),
  qty: qtySchema,
  unitCost: moneySchema.optional(),
  unitSell: moneySchema.optional(),
});

export const lcdScreenSchema = z.object({
  screenName: z.string().max(120).optional(),
  orientation: z.enum(['P', 'L']).optional(),
  displayId: idSchema.optional(),
  installMethodId: idSchema.optional(),
  serviceHoursId: idSchema.optional(),
  warrantyId: idSchema.optional(),
  items: z.array(lcdItemSchema).default([]),
});
export type LcdScreenInput = z.infer<typeof lcdScreenSchema>;

// ─── Screen management (duplicate / reorder / per-screen qty) — P1-14 ─────────
/** Reorder screens: the full set of screen ids in their new order. */
export const reorderScreensSchema = z.object({
  orderedIds: z.array(z.coerce.number().int().positive()).min(1),
});
export type ReorderScreensInput = z.infer<typeof reorderScreensSchema>;

/** Patch a single screen's quantity (positive integer; 0/negative rejected). */
export const screenQtySchema = z.object({
  qty: z.coerce.number().int().positive(),
});
export type ScreenQtyInput = z.infer<typeof screenQtySchema>;

// ─── Manual price overrides (P1-17) ───────────────────────────────────────────
/** Override target kinds. Open-ended by design; only 'led_screen_price' is wired today. */
export const OVERRIDE_TARGET_TYPES = ['led_screen_price'] as const;
export type OverrideTargetType = (typeof OVERRIDE_TARGET_TYPES)[number];

/**
 * Set a manual override on a computed field. `value` must be a finite, non-negative number
 * (negative/NaN rejected at validation → 400). A value that lowers margin is allowed but warned.
 */
export const setOverrideSchema = z.object({
  targetType: z.enum(OVERRIDE_TARGET_TYPES).default('led_screen_price'),
  targetId: z.coerce.bigint(),
  value: z.coerce.number().refine((v) => Number.isFinite(v) && v >= 0, {
    message: 'Override value must be a finite, non-negative number',
  }),
  reason: z.string().max(500).optional(),
});
export type SetOverrideInput = z.infer<typeof setOverrideSchema>;

// ─── Simple quote line collections (skippable wizard steps) ───────────────────
const refQty = (key: string) =>
  z.object({ [key]: idSchema, qty: qtySchema } as Record<string, z.ZodTypeAny>);

export const quoteMediaplayerSchema = refQty('mediaplayerId');
export const quotePeripheralSchema = refQty('peripheralId');
export const quoteManufacturedSchema = refQty('productId');
export const quoteAudioSchema = refQty('audioProductId');
export const quoteSoftwareSchema = refQty('softwareActivityId');

export const quoteMusicSchema = z.object({ musicServiceId: idSchema, qty: qtySchema });
export const quoteHypervsnSchema = z.object({
  hypervsnProductId: idSchema,
  qty: qtySchema,
  rateCard: z.enum(['aud', 'reseller_aud', 'nzd', 'reseller_nzd']).default('aud'),
});

// ─── Proposal text (assumptions / exclusions / T&Cs) — P1-18.2 ────────────────
/** A single proposal-text line; `kind` groups it in the PDF. */
export const TERM_KINDS = ['assumption', 'exclusion', 'term'] as const;
export type TermKind = (typeof TERM_KINDS)[number];

/** The full ordered set of proposal-text lines; seq is derived from the array index on save. */
export const quoteTermsSchema = z.object({
  terms: z.array(
    z.object({
      kind: z.enum(TERM_KINDS),
      text: z.string().min(1).max(2000),
    }),
  ),
});
export type QuoteTermsInput = z.infer<typeof quoteTermsSchema>;

export const quoteLicenceSchema = z.object({
  licenceComponentId: idSchema.optional(),
  screenType: z.enum(SCREEN_TYPES),
  tier: z.enum(LICENCE_TIERS),
  qty: qtySchema,
  isInteractive: z.boolean().default(false),
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;
