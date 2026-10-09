import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // lcov feeds Codecov; json + json-summary feed the PR coverage table.
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/**/__tests__/**',
      ],
      all: true,
      // CI gate (#1333). Long-term target is 80/75/80/80; the floors below
      // are the measured baseline and only ever ratchet upwards, so a PR that
      // drops coverage below them fails. Codecov additionally blocks any PR
      // that lowers project coverage by more than 1% (see .github/codecov.yml).
      thresholds: {
        statements: 50,
        branches: 75,
        functions: 65,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
