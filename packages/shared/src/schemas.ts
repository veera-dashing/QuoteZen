import { z } from 'zod';
import {
  CURRENCY_CODES,
  DISCOUNT_MODES,
  DISCOUNT_SCOPES,
  LED_COMPONENT_TYPES,
  LICENCE_TIERS,
  ORIENTATIONS,
  QUOTE_STATUSES,
  RISK_CATEGORIES,
  RISK_SEVERITIES,
  REVIEW_DECISIONS,
  REVIEW_STAGES,
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
  /** Quote-level discount override (U0), fraction 0..1; wins over the client/system default. Not yet applied to pricing. */
  discountPct: z.coerce.number().min(0).max(1).optional(),
  /** Where the discount applies (U5): one-off upfront concession (default) vs every renewal. */
  discountScope: z.enum(DISCOUNT_SCOPES).default('one_off'),
  /** Quote-wide PI capture (U0). */
  siteAddress: z.string().max(500).optional(),
  projectNotes: z.string().max(2000).optional(),
  /** Viewer users this quote is shared with (they can read only quotes assigned to them). */
  viewerUserIds: z.array(idSchema).optional(),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = createQuoteSchema.partial().extend({
  // Nullable on update so the editor can *clear* a client/location (the service sets the FK to null).
  clientId: idSchema.nullish(),
  locationId: idSchema.nullish(),
  // Nullable on update so the editor can clear the discount/PI fields (U0).
  discountPct: z.coerce.number().min(0).max(1).nullish(),
  /** Discount scope (U5); optional on update. */
  discountScope: z.enum(DISCOUNT_SCOPES).optional(),
  /** Per-quote discount mode (V2): how per-line discounts fold with the quote/client discount. */
  discountMode: z.enum(DISCOUNT_MODES).optional(),
  siteAddress: z.string().max(500).nullish(),
  projectNotes: z.string().max(2000).nullish(),
  /** Optimistic-locking token from the last read; a mismatch is a 409 conflict (P1-05.2). */
  expectedVersion: z.coerce.number().int().nonnegative().optional(),
});
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(QUOTE_STATUSES),
  reason: z.string().max(500).optional(),
});

/**
 * Record a two-stage review decision (T1 / BR-001). A `technical` or `commercial` reviewer either
 * approves (advancing the workflow) or rejects (kicking the quote back) with an optional comment.
 */
export const recordReviewSchema = z.object({
  stage: z.enum(REVIEW_STAGES),
  decision: z.enum(REVIEW_DECISIONS),
  comment: z.string().max(2000).optional(),
});
export type RecordReviewInput = z.infer<typeof recordReviewSchema>;

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

/**
 * Patch an EXISTING LED screen's secondary options / services (U0). The product + geometry
 * (ledProductId, desiredWidth/HeightMm, rotateCabinets, components, orientation, aspectRatio) are
 * finalised when the screen is added and are NOT editable here — this is the "edit trim/frame/etc."
 * second form. Every field is optional; `null` clears the FK / note. Re-prices the screen.
 */
export const updateLedScreenSchema = z.object({
  gobId: idSchema.nullish(),
  frameId: idSchema.nullish(),
  trimId: idSchema.nullish(),
  hangingBarId: idSchema.nullish(),
  engineeringId: idSchema.nullish(),
  installMethodId: idSchema.nullish(),
  freightOptionId: idSchema.nullish(),
  warrantyId: idSchema.nullish(),
  serviceHoursId: idSchema.nullish(),
  accessEquipmentId: idSchema.nullish(),
  backCover: z.boolean().optional(),
  frameNote: z.string().max(500).nullish(),
  serviceDescriptionSuffix: z.string().max(500).nullish(),
  marginOverride: z.coerce.number().min(0).max(0.99).nullish(),
});
export type UpdateLedScreenInput = z.infer<typeof updateLedScreenSchema>;

// ─── LCD screen config (the LCD-1 questionnaire) ──────────────────────────────
export const lcdItemSchema = z.object({
  displayId: idSchema.optional(),
  itemType: z.enum(['display', 'mediaplayer', 'bracket', 'install', 'labour', 'location_fee', 'warranty']),
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

/**
 * Set/clear a per-line discount (V2) on a LED cost-breakdown line or an LCD item. `discountPct` is a
 * fraction 0..1 (nullable → clears the discount). Reduces that line's sell in the rollup + margin.
 */
export const lineDiscountSchema = z.object({
  discountPct: z.coerce.number().min(0).max(1).nullable(),
});
export type LineDiscountInput = z.infer<typeof lineDiscountSchema>;

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

// ─── Manual assumptions & risks register (T4 / FR-038–041, FR-095) ────────────
/**
 * The full ordered set of manually-captured risks; seq is derived from the array index on save.
 * Assumptions reuse the proposal-text terms (kind=assumption) — this is the risks half.
 */
export const quoteRisksSchema = z.object({
  risks: z.array(
    z.object({
      category: z.enum(RISK_CATEGORIES),
      description: z.string().min(1).max(1000),
      severity: z.enum(RISK_SEVERITIES),
      mitigation: z.string().max(1000).optional(),
    }),
  ),
});
export type QuoteRisksInput = z.infer<typeof quoteRisksSchema>;

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
