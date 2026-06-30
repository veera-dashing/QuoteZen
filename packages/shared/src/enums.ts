/** Canonical enums shared across the API, the pricing engine, and the web wizard. */

export const CURRENCY_CODES = ['AUD', 'USD', 'EUR', 'NZD', 'SGD', 'ZAR', 'GBP', 'MYR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const QUOTE_STATUSES = [
  'draft',
  'in_review',
  // Two-stage human review & approval (T1 / BR-001, FR-102–110): a quote passes a technical review
  // then a commercial review before it can be approved and issued.
  'technical_review',
  'commercial_review',
  'approved',
  'issued',
  'won',
  'lost',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** The two review stages (T1). A quote needs an `approved` review at each stage to be issued. */
export const REVIEW_STAGES = ['technical', 'commercial'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** A reviewer's decision at a stage: approve (advance) or reject (kick back). */
export const REVIEW_DECISIONS = ['approved', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const SCREEN_TYPES = ['LED', 'LCD'] as const;
export type ScreenType = (typeof SCREEN_TYPES)[number];

export const LICENCE_TIERS = ['low', 'high'] as const;
export type LicenceTier = (typeof LICENCE_TIERS)[number];

export const LED_COMPONENT_TYPES = [
  'controller',
  'led_peripheral',
  'mediaplayer',
  'mediaplayer_peripheral',
] as const;
export type LedComponentType = (typeof LED_COMPONENT_TYPES)[number];

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'status_change'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const USER_ROLES = ['admin', 'sales', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** LED screen orientation (LED-1 E10). */
export const ORIENTATIONS = ['Landscape', 'Portrait'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];
