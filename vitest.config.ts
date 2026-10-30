import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    // DB tests share one Postgres database, so files must not run concurrently.
    fileParallelism: false,
  },
});
