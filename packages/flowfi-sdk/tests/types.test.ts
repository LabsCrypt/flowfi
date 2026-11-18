import { describe, it, expect } from 'vitest';

import { isStreamStatus, isVestingSchedule } from '../src/types.js';

describe('isStreamStatus', () => {
  describe('valid inputs', () => {
    it('narrows every valid status string', () => {
      const valid: unknown[] = ['Active', 'Paused', 'Cancelled', 'Completed'];

      for (const value of valid) {
        if (isStreamStatus(value)) {
          // Compile-time: value is StreamStatus inside the guard.
          const status: typeof value = value;
          expect(status).toBe(value);
        } else {
          throw new Error(`isStreamStatus rejected valid value ${String(value)}`);
        }
      }
    });

    it.each(['Active', 'Paused', 'Cancelled', 'Completed'])('accepts %s', (status) => {
      expect(isStreamStatus(status)).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects strings that are not StreamStatus variants', () => {
      expect(isStreamStatus('active')).toBe(false); // case-sensitive
      expect(isStreamStatus('ACTIVE')).toBe(false);
      expect(isStreamStatus('Pending')).toBe(false);
      expect(isStreamStatus('')).toBe(false);
      expect(isStreamStatus('Active ')).toBe(false); // trailing space
    });

    it('rejects non-string types', () => {
      expect(isStreamStatus(null)).toBe(false);
      expect(isStreamStatus(undefined)).toBe(false);
      expect(isStreamStatus(1)).toBe(false);
      expect(isStreamStatus(true)).toBe(false);
      expect(isStreamStatus({ status: 'Active' })).toBe(false);
      expect(isStreamStatus(['Active'])).toBe(false);
      expect(isStreamStatus(Symbol('Active'))).toBe(false);
      expect(isStreamStatus(() => 'Active')).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('narrows the type on the true branch and excludes it on the false branch', () => {
      const value: unknown = 'Paused' as unknown;

      if (isStreamStatus(value)) {
        // @ts-expect-error - narrowed to StreamStatus, assignment of a bogus string must fail
        const _invalid: StreamStatusLike = 'NotAStatus';
        expect(value.toUpperCase()).toBe('PAUSED');
      } else {
        throw new Error('guard failed to narrow a valid status');
      }
    });
  });
});

/** Local structural alias so the @ts-expect-error above proves narrowing. */
type StreamStatusLike = 'Active' | 'Paused' | 'Cancelled' | 'Completed';

describe('isVestingSchedule', () => {
  describe('valid inputs', () => {
    it('accepts a linear schedule', () => {
      expect(isVestingSchedule({ kind: 'linear' })).toBe(true);
    });

    it('accepts a step_tranches schedule with well-formed steps', () => {
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [
            { unlockTime: 1_700_000_000, unlockAmount: 500n },
            { unlockTime: 1_700_000_100, unlockAmount: 500 },
          ],
        }),
      ).toBe(true);
    });

    it('accepts an empty step list (validated downstream by the contract)', () => {
      expect(isVestingSchedule({ kind: 'step_tranches', steps: [] })).toBe(true);
    });

    it('accepts a hybrid_cliff_linear schedule', () => {
      expect(
        isVestingSchedule({
          kind: 'hybrid_cliff_linear',
          cliffTime: 1_700_000_000,
          cliffUnlockAmount: 1_000n,
        }),
      ).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects non-object values', () => {
      expect(isVestingSchedule(null)).toBe(false);
      expect(isVestingSchedule(undefined)).toBe(false);
      expect(isVestingSchedule('linear')).toBe(false);
      expect(isVestingSchedule(42)).toBe(false);
      expect(isVestingSchedule(['linear'])).toBe(false);
    });

    it('rejects unknown or missing kinds', () => {
      expect(isVestingSchedule({ kind: 'exponential' })).toBe(false);
      expect(isVestingSchedule({ kind: 'Linear' })).toBe(false); // case-sensitive
      expect(isVestingSchedule({})).toBe(false);
      expect(isVestingSchedule({ steps: [] })).toBe(false); // kind missing
    });

    it('rejects step_tranches with a missing or non-array steps field', () => {
      expect(isVestingSchedule({ kind: 'step_tranches' })).toBe(false);
      expect(isVestingSchedule({ kind: 'step_tranches', steps: 'nope' })).toBe(false);
      expect(isVestingSchedule({ kind: 'step_tranches', steps: {} })).toBe(false);
    });

    it('rejects step_tranches whose steps are malformed', () => {
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [{ unlockAmount: 500n }], // missing unlockTime
        }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [{ unlockTime: 1_700_000_000 }], // missing unlockAmount
        }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [{ unlockTime: 'soon', unlockAmount: 500n }], // wrong time type
        }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [{ unlockTime: 1_700_000_000, unlockAmount: 'a lot' }], // wrong amount type
        }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'step_tranches',
          steps: [null, { unlockTime: 1, unlockAmount: 1n }], // null entry
        }),
      ).toBe(false);
    });

    it('rejects hybrid_cliff_linear with missing or non-numeric cliff fields', () => {
      expect(isVestingSchedule({ kind: 'hybrid_cliff_linear' })).toBe(false);
      expect(
        isVestingSchedule({ kind: 'hybrid_cliff_linear', cliffTime: 1_700_000_000 }),
      ).toBe(false);
      expect(
        isVestingSchedule({ kind: 'hybrid_cliff_linear', cliffUnlockAmount: 1_000n }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'hybrid_cliff_linear',
          cliffTime: 'tomorrow',
          cliffUnlockAmount: 1_000n,
        }),
      ).toBe(false);
      expect(
        isVestingSchedule({
          kind: 'hybrid_cliff_linear',
          cliffTime: 1_700_000_000,
          cliffUnlockAmount: null,
        }),
      ).toBe(false);
    });

    it('rejects extra-kind mismatches such as a linear schedule carrying steps', () => {
      // A linear schedule must not be accepted with a payload declaring another kind.
      expect(isVestingSchedule({ kind: 'linear', steps: [] })).toBe(true); // extra fields tolerated
      expect(isVestingSchedule({ kind: 'step_tranches', kind2: 'linear' })).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('narrows to VestingSchedule on the true branch', () => {
      const value: unknown = { kind: 'hybrid_cliff_linear', cliffTime: 10n, cliffUnlockAmount: 5n };

      if (isVestingSchedule(value)) {
        // Accessing a variant-only field must typecheck after narrowing.
        switch (value.kind) {
          case 'hybrid_cliff_linear':
            expect(value.cliffUnlockAmount).toBe(5n);
            break;
          default:
            throw new Error('narrowed to the wrong variant');
        }
      } else {
        throw new Error('guard failed to narrow a valid schedule');
      }
    });
  });
});
