import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 30000,
    include: [
      'apps/**/*.test.js',
      'packages/**/*.test.js',
      'tests/**/*.test.js',
    ],
  },
});
