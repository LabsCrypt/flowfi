import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startWorkers, stopWorkers } from '../src/workers/index.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
  },
}));

describe('Workers Index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start workers', async () => {
    await startWorkers();
    expect(sorobanEventWorker.start).toHaveBeenCalled();
  });

  it('should stop workers', () => {
    stopWorkers();
    expect(sorobanEventWorker.stop).toHaveBeenCalled();
  });
});
