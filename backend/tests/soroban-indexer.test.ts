import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sorobanIndexerService } from '../src/services/soroban-indexer.service.js';

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Soroban Indexer Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start and stop the indexer', () => {
    sorobanIndexerService.start();
    sorobanIndexerService.stop();
  });
});
