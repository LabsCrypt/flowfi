import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  bigIntSafeJsonMiddleware,
  bigIntSafeReplacer,
  stringifyJson,
} from '../src/lib/serialize.js';

describe('BigInt-safe serializer (#1493)', () => {
  it('encodes a top-level BigInt as a decimal string', () => {
    expect(stringifyJson({ streamId: 123456789012345678901234567890n })).toBe(
      '{"streamId":"123456789012345678901234567890"}',
    );
  });

  it('serializes nested objects and arrays containing BigInts', () => {
    const payload = {
      streams: [
        { streamId: 42n, meta: { depositedAmount: 9007199254740993n } },
        { streamId: 7n, withdrawable: [1n, 2n, 3n] },
      ],
      total: 2,
    };

    const parsed = JSON.parse(stringifyJson(payload)!);

    expect(parsed.streams[0].streamId).toBe('42');
    expect(parsed.streams[0].meta.depositedAmount).toBe('9007199254740993');
    expect(parsed.streams[1].withdrawable).toEqual(['1', '2', '3']);
    expect(parsed.total).toBe(2);
  });

  it('leaves plain values untouched', () => {
    const payload = {
      address: 'GABC',
      amount: 1.5,
      active: true,
      pausedAt: null,
      tags: ['a', 1],
    };

    expect(JSON.parse(stringifyJson(payload)!)).toEqual(payload);
  });

  it('does not depend on a global BigInt.prototype.toJSON patch', () => {
    // `stream-id.ts` installs such a patch as a side effect, but this module
    // must work even when the patch was never applied (the module was not
    // imported by any earlier request handler).
    expect((BigInt.prototype as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
    expect(stringifyJson({ value: 7n })).toBe('{"value":"7"}');
  });

  it('returns undefined for un-serializable input, like JSON.stringify', () => {
    expect(stringifyJson(undefined)).toBeUndefined();
  });

  it('passes unknown keys through the replacer unchanged', () => {
    expect(bigIntSafeReplacer('key', 'str')).toBe('str');
    expect(bigIntSafeReplacer('key', 5n)).toBe('5');
  });

  it('routes every res.json() call through the serializer', async () => {
    const app = express();
    app.use(bigIntSafeJsonMiddleware);
    app.get('/big-int', (_req, res) => {
      res.json({ streamId: 9007199254740993n, nested: [{ value: 5n }] });
    });

    const response = await request(app).get('/big-int');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({
      streamId: '9007199254740993',
      nested: [{ value: '5' }],
    });
  });
});
