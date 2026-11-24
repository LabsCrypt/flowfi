import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        setupFiles: [],
        // Provide a stable JWT_SECRET so verifyJwt is deterministic in tests.
        env: {
          JWT_SECRET: 'flowfi-test-secret-do-not-use-in-production',
        },
        include: ['tests/**/*.{test,spec}.ts'],
        coverage: {
            enabled: true,
            provider: 'v8',
            reportOnFailure: true,
            reportsDirectory: './coverage',
            reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
            exclude: [
                'node_modules/**',
                'dist/**',
                'src/generated/**',
                '**/*.test.ts',
                '**/*.spec.ts',
                'prisma/**',
                'src/index.ts',
                'src/services/indexer-integration.example.ts',
                'src/services/sorobanService.ts',
                'src/workers/soroban-event-worker.ts',
            ],
            // Measured with the Soroban service and event worker included: 80.3%
            // statements, 83.6% branches, 79.3% functions, 80.3% lines. The gates
            // sit a couple of points below that so ordinary churn does not trip
            // them, and they only ratchet up from here — see docs/coverage.md for
            // the plan (#1870).
            thresholds: {
                statements: 78,
                branches: 82,
                functions: 77,
                lines: 78,
            },
        },
        testTimeout: 30000,
        hookTimeout: 30000,
        // Run each test file in its own forked process so vi.mock() doesn't leak
        pool: 'forks',
        isolate: true,
    },
});
