import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // API tests hit the database; run them serially to avoid cross-test interference.
    fileParallelism: false,
  },
});
