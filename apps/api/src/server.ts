import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { buildApp } from './app.js';
import { assertConfig } from './config.js';

// Load the monorepo root .env so DATABASE_URL / JWT_SECRET are available in dev and prod.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const start = async (): Promise<void> => {
  // Fail-closed: validate env before doing anything else; exits non-zero on missing/bad config.
  const config = assertConfig();
  const app = await buildApp(config);
  try {
    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
