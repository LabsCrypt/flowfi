# Coverage gates

Coverage is enforced by Vitest thresholds in each workspace's config. A PR that
drops a metric below its floor fails CI; the floors are never lowered, only
raised.

## Backend (`backend/vitest.config.ts`)

The Soroban service (`src/services/sorobanService.ts`), the event indexer
(`src/workers/soroban-event-worker.ts`) and `src/services/indexer.service.ts`
used to be excluded from measurement — exactly the code that custodies stream
state and submits transactions. They are now measured like everything else.

Measured on `main` with the whole backend suite:

| Metric | Measured | Gate |
| --- | --- | --- |
| Statements | 80.3% | 78 |
| Branches | 83.6% | 82 |
| Functions | 79.3% | 77 |
| Lines | 80.3% | 78 |

The payment-critical modules are individually healthier than the average
(`sorobanService.ts` 83.9% statements, `soroban-event-worker.ts` 89.2%), so
including them raised the total instead of hiding behind a lower denominator.

### Plan for incremental raises

1. The gates sit ~2 points under the measured values so unrelated churn does not
   trip them.
2. Each time a PR adds tests, re-measure and raise any gate that is now more
   than 3 points below its metric — in the same PR.
3. Target: 85% on every metric, with `sorobanService.ts` and the event worker at
   90%+ because they carry the money paths.
4. New modules are measured from the day they land; a deliberate exclusion needs
   a comment in `vitest.config.ts` explaining why the code cannot be tested.

## Frontend (`frontend/vitest.config.ts`)

The frontend gate is already honest and higher than the backend's: 50%
statements/lines, 75% branches, 65% functions, covering all of `src/**` with no
exclusions beyond test files. Codecov additionally blocks any PR that lowers
project coverage by more than 1% (`.github/codecov.yml`), so the next raise
should be driven by the Codecov trend rather than a one-off measurement.

## Reporting only what is measured

Coverage is a floor, not a substitute for assertions: a module can be 90%
covered by tests that assert nothing. When adding a test for a value path,
assert the resulting state (balances, storage, events), not just that the call
returned `Ok`.
