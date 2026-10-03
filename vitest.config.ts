import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
    testTimeout: 20000,
    reporters: ['dot'],
  },
});
