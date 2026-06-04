import { describe, it, expect } from 'vitest';
import { isStale } from '../src/services/sorobanService.js';

describe('Soroban Service', () => {
  describe('isStale', () => {
    it('should return true if updated more than 30s ago', () => {
      const longAgo = new Date(Date.now() - 31000);
      expect(isStale(longAgo)).toBe(true);
    });

    it('should return false if updated recently', () => {
      const recently = new Date(Date.now() - 5000);
      expect(isStale(recently)).toBe(false);
    });
  });
});
