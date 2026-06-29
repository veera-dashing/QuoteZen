import { z } from 'zod';
import {
  CURRENCY_CODES,
  LED_COMPONENT_TYPES,
  LICENCE_TIERS,
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
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = createQuoteSchema.partial();
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(QUOTE_STATUSES),
  reason: z.string().max(500).optional(),
});

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
  displayId: idSchema.optional(),
  installMethodId: idSchema.optional(),
  serviceHoursId: idSchema.optional(),
  warrantyId: idSchema.optional(),
  items: z.array(lcdItemSchema).default([]),
});
export type LcdScreenInput = z.infer<typeof lcdScreenSchema>;

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
