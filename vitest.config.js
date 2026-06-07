import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    include: [
      'apps/**/*.test.js',
      'packages/**/*.test.js',
      'tests/**/*.test.js',
    ],
  },
});
