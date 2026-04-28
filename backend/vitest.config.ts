import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        setupFiles: [],
        include: ['tests/**/*.{test,spec}.ts', 'src/__tests__/**/*.{test,spec}.ts'],
        coverage: {
            reporter: ['text', 'json', 'html', 'lcov'],
            thresholds: {
                lines: 50,
                functions: 50,
                branches: 50,
                statements: 50,
            }
        },
        testTimeout: 30000,
        hookTimeout: 30000,
        // Run each test file in its own forked process so vi.mock() doesn't leak
        pool: 'forks',
        isolate: true,
    },
});
