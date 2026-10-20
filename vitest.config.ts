import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 2,
    testTimeout: 20000,
    reporters: ['dot'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/core/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Ratchet floor, measured 2026-10-20 (core ~89% lines overall including UI drag).
      // Raise these as route/UI coverage grows; never lower them in a PR that adds code.
      thresholds: { lines: 80, statements: 80, branches: 65, functions: 75 },
    },
  },
});
