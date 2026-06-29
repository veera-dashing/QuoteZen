import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

// Load the monorepo root .env (DATABASE_URL etc.) before any module reads process.env / Prisma boots.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-please-change';
