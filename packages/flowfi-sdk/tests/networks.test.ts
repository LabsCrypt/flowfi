import { describe, it, expect } from 'vitest';
import {
  NETWORK_PASSPHRASES,
  validateNetworkPassphrase,
} from '../src/networks.js';

describe('validateNetworkPassphrase', () => {
  it('accepts every official passphrase without a hint', () => {
    for (const [network, passphrase] of Object.entries(NETWORK_PASSPHRASES)) {
      const result = validateNetworkPassphrase(passphrase);
      expect(result.valid, `${network} should be valid`).toBe(true);
      expect(result.network).toBe(network);
      expect(result.hint).toBeUndefined();
      expect(result.suggestion).toBeUndefined();
    }
  });

  it('rejects an unrecognised passphrase with a helpful hint', () => {
    const result = validateNetworkPassphrase('Totally Fake Network');
    expect(result.valid).toBe(false);
    expect(result.hint).toMatch(/Unrecognised network passphrase/);
    expect(result.network).toBeUndefined();
  });

  it('suggests the closest network for a near-miss typo', () => {
    // Missing the spaces around the semicolon is the classic mistake.
    const result = validateNetworkPassphrase('Test SDF Network;September 2015');
    expect(result.valid).toBe(false);
    expect(result.suggestion).toBe(NETWORK_PASSPHRASES.testnet);
    expect(result.hint).toMatch(/Did you mean/);
  });

  it('is case-sensitive about the canonical passphrase', () => {
    const result = validateNetworkPassphrase('test sdf network ; september 2015');
    expect(result.valid).toBe(false);
    expect(result.suggestion).toBe(NETWORK_PASSPHRASES.testnet);
  });

  it('does not suggest anything for wildly different input', () => {
    const result = validateNetworkPassphrase('completely unrelated');
    expect(result.valid).toBe(false);
    expect(result.suggestion).toBeUndefined();
  });
});
