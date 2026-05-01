import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/utils/**', 'src/hooks/**', 'src/components/**'],
      thresholds: {
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
