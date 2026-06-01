import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('JWT helpers', () => {
  const JWT_SECRET = 'test-jwt-secret';
  let signJwt: (payload: object) => string;
  let verifyJwt: (token: string) => { publicKey: string } | null;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('JWT_SECRET', JWT_SECRET);

    const auth = await import('../src/middleware/auth.js');
    signJwt = auth.signJwt;
    verifyJwt = auth.verifyJwt;
  });

  it('round-trips through verifyJwt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600 });

    expect(verifyJwt(token)).toEqual({ publicKey: 'GTESTPUBLICKEY123' });
  });

  it('returns null for a tampered header', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600 });
    const parts = token.split('.') as [string, string, string];
    parts[0] = parts[0].slice(0, -1) + (parts[0].slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for a tampered body', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600 });
    const parts = token.split('.') as [string, string, string];
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for a tampered signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600 });
    const parts = token.split('.') as [string, string, string];
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now - 3600, exp: now - 1 });

    expect(verifyJwt(token)).toBeNull();
  });

  it('returns null for a malformed token missing dots', async () => {
    expect(verifyJwt('abc.def')).toBeNull();
  });

  it('returns null for an entirely fabricated string', async () => {
    expect(verifyJwt('totally.fake.token')).toBeNull();
  });
});
