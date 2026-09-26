import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression guard for https://github.com/LabsCrypt/flowfi/issues/1281:
// having both vitest.config.ts and vitest.config.mts at the same time makes
// the resolved test config ambiguous (Vite/Vitest pick one based on
// extension resolution order, which is not obvious to contributors and can
// silently disable the "other" config's environment, setup file, and
// coverage thresholds). Only one vitest.config.* should ever exist.
describe('vitest config', () => {
  it('has exactly one vitest.config.* file in the frontend package', () => {
    const frontendRoot = path.resolve(__dirname, '..', '..');
    const configFiles = fs
      .readdirSync(frontendRoot)
      .filter((f) => /^vitest\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(f));

    expect(configFiles).toEqual(['vitest.config.ts']);
  });
});
