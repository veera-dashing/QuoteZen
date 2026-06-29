import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // API tests hit a remote database; run serially and allow generous time per test.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
