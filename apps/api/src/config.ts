import { z } from 'zod';

/** Validated runtime configuration. Fails fast at boot if the environment is misconfigured. */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().default('12h'),
});

export type AppConfig = z.infer<typeof configSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
};

/**
 * Fail-closed boot validation (P1-01.4): parse + validate required env BEFORE the server starts
 * listening. On any missing/malformed config, print a clear fatal error and exit non-zero rather
 * than starting in a broken state. Never prints the offending values (only the field names/reasons),
 * so secrets are not leaked to logs.
 */
export const assertConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  try {
    return loadConfig(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Boot happens before the Fastify logger exists; write to stderr directly.
    process.stderr.write(`FATAL: refusing to start — ${message}\n`);
    process.exit(1);
  }
};
