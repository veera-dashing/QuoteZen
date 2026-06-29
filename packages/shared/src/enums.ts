/** Canonical enums shared across the API, the pricing engine, and the web wizard. */

export const CURRENCY_CODES = ['AUD', 'USD', 'EUR', 'NZD', 'SGD', 'ZAR', 'GBP', 'MYR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const QUOTE_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'issued',
  'won',
  'lost',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

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
