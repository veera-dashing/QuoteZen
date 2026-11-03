import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { assertWebhookSecret, secretMatches } from './webhook.js';

describe('Zoho webhook secret', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('s3cret-value-123456', 's3cret-value-123456')).toBe(true);
    expect(secretMatches('s3cret-value-123456', 's3cret-value-12345')).toBe(false);
    expect(secretMatches('s3cret-value-123456', 'S3CRET-VALUE-123456')).toBe(false);
    expect(secretMatches('s3cret-value-123456', undefined)).toBe(false);
    expect(secretMatches('s3cret-value-123456', '')).toBe(false);
  });

  it('answers 503 not_configured when no secret is set, 401 when it does not match', () => {
    const err = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected a throw');
    };
    expect(err(() => assertWebhookSecret({} as AppConfig, 'x')).statusCode).toBe(503);
    const config = { ZOHO_WEBHOOK_SECRET: 's3cret-value-123456' } as AppConfig;
    expect(err(() => assertWebhookSecret(config, 'nope')).statusCode).toBe(401);
    expect(() => assertWebhookSecret(config, 's3cret-value-123456')).not.toThrow();
  });
});
