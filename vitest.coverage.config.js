import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 30000,
    include: [
      'apps/**/*.test.js',
      'packages/**/*.test.js',
      'tests/unit/**/*.test.js',
    ],
    exclude: ['tests/unit/stage-app-assets.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: 'coverage/vitest',
      all: true,
      include: [
        'apps/extension/**/*.js',
        'apps/desktop/ui/**/*.js',
        'packages/**/*.js',
      ],
      exclude: [
        'apps/extension/savepage/**',
        'apps/extension/vendor/**',
        'apps/desktop/ui/vendor/**',
        'dist/**',
        'tests/**',
        '**/*.test.js',
        '**/*.spec.js',
      ],
    },
  },
});
