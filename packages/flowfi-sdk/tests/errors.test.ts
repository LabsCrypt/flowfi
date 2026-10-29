import { describe, it, expect } from 'vitest';
import { CONTRACT_ERRORS, parseContractError } from '../src/errors.js';

describe('CONTRACT_ERRORS and parseContractError (#1657)', () => {
  it('exports comprehensive CONTRACT_ERRORS map matching Soroban stream_contract', () => {
    expect(CONTRACT_ERRORS[1]).toEqual({
      code: 1,
      name: 'InvalidAmount',
      message: expect.stringContaining('Amount is zero'),
    });
    expect(CONTRACT_ERRORS[2]).toEqual({
      code: 2,
      name: 'StreamNotFound',
      message: expect.stringContaining('No stream exists'),
    });
    expect(CONTRACT_ERRORS[4]).toEqual({
      code: 4,
      name: 'StreamInactive',
      message: expect.stringContaining('active stream'),
    });
    expect(CONTRACT_ERRORS[12]).toEqual({
      code: 12,
      name: 'StreamPaused',
      message: expect.stringContaining('paused'),
    });
    expect(CONTRACT_ERRORS[15]).toEqual({
      code: 15,
      name: 'ProtocolPaused',
      message: expect.stringContaining('circuit breaker'),
    });
    expect(CONTRACT_ERRORS[48]).toEqual({
      code: 48,
      name: 'InsufficientOutput',
      message: expect.stringContaining('minimum output'),
    });
  });

  describe('parseContractError', () => {
    it('parses Soroban HostError strings with # prefix', () => {
      const parsed = parseContractError('HostError: Error(Contract, #4)');
      expect(parsed).toEqual({
        code: 4,
        name: 'StreamInactive',
        message: 'Operation requires an active stream, but the stream is inactive.',
      });
    });

    it('parses Soroban strings without # prefix', () => {
      const parsed = parseContractError('Transaction failed: Error(Contract, 2)');
      expect(parsed).toEqual({
        code: 2,
        name: 'StreamNotFound',
        message: 'No stream exists for the supplied ID.',
      });
    });

    it('parses Error objects carrying contract error diagnostic messages', () => {
      const err = new Error('Simulation failed with HostError: Error(Contract, #1)');
      const parsed = parseContractError(err);
      expect(parsed).toEqual({
        code: 1,
        name: 'InvalidAmount',
        message: 'Amount is zero, negative, or otherwise out of range.',
      });
    });

    it('parses ContractError(N) formatted strings', () => {
      const parsed = parseContractError('ContractError(12)');
      expect(parsed).toEqual({
        code: 12,
        name: 'StreamPaused',
        message: 'Operation requires an active stream, but the stream is currently paused.',
      });
    });

    it('handles unknown contract error codes gracefully', () => {
      const parsed = parseContractError('Error(Contract, #999)');
      expect(parsed).toEqual({
        code: 999,
        name: 'ContractError_999',
        message: 'Soroban contract error #999',
      });
    });

    it('returns null for non-contract errors', () => {
      expect(parseContractError('Network connection refused')).toBeNull();
      expect(parseContractError(new Error('SyntaxError: unexpected token'))).toBeNull();
      expect(parseContractError(null)).toBeNull();
      expect(parseContractError(undefined)).toBeNull();
      expect(parseContractError({})).toBeNull();
      expect(parseContractError(12345)).toBeNull();
    });
  });
});
