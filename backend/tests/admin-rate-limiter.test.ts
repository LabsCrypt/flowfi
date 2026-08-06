import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {},
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { adminRateLimiter } from '../src/middleware/admin-rate-limiter.middleware.js';

describe('adminRateLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a function', () => {
    expect(typeof adminRateLimiter).toBe('function');
  });
});
