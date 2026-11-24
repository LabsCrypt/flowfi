/**
 * Issue #1745: repeated cancellation, concurrent cancellation, and
 * already-completed streams.
 *
 * These tests drive `cancelStreamHandler` directly (the same level
 * `tests/cancel.controller.test.ts` works at) and pin the parts of the
 * contract that file does not reach: what a second request does, what a
 * request against a finished-but-not-cancelled stream does, the two
 * streamId rejections, and that every relay failure is a 500 rather than a
 * success the client would not retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancelStreamHandler } from '../src/controllers/stream/cancel.js';
import { prisma } from '../src/lib/prisma.js';
import * as sorobanService from '../src/services/sorobanService.js';
import * as streamRepository from '../src/repositories/stream.repository.js';
import { ApiError } from '../src/lib/api-error.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/services/sorobanService.js', () => ({
  submitSignedCancel: vi.fn(),
}));

vi.mock('../src/repositories/stream.repository.js', () => ({
  updateStatus: vi.fn(),
  markCancelledProvisionally: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const SENDER = 'GSENDER1';
// Opaque to the handler: `submitSignedCancel` is mocked, so only its presence
// and type are under test here. Envelope parsing is covered in
// tests/signed-cancel-relay.test.ts.
const SIGNED_XDR = 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=';

type MockFn = ReturnType<typeof vi.fn>;

const findUnique = prisma.stream.findUnique as unknown as MockFn;
const cancelOnChain = sorobanService.submitSignedCancel as unknown as MockFn;
const markCancelled = streamRepository.markCancelledProvisionally as unknown as MockFn;

/** What a successful relay must be asked for: the bytes plus the who/what. */
function relayArgs(streamId: bigint, sender = SENDER) {
  return [SIGNED_XDR, { streamId, senderAddress: sender }];
}

function activeStream(overrides: Record<string, unknown> = {}) {
  return { streamId: 123n, sender: SENDER, isActive: true, status: 'ACTIVE', ...overrides };
}

function cancelledStream() {
  return activeStream({ isActive: false, status: 'CANCELLED' });
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: { streamId: '123' },
    user: { publicKey: SENDER },
    body: { signedXdr: SIGNED_XDR },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { status: MockFn; json: MockFn } {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: MockFn; json: MockFn };
}

/** The `{ error: { code, message } }` envelope `sendApiError` writes. */
function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** The error envelope the response actually carried, for code-only assertions. */
function firstError(res: ReturnType<typeof makeRes>): { code: string; message: string } {
  return (res.json as MockFn).mock.calls[0]?.[0]?.error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The three dependencies every successful cancel needs. */
function stubHappyPath(txHash = 'tx_first') {
  findUnique.mockResolvedValue(activeStream());
  cancelOnChain.mockResolvedValue(txHash);
  markCancelled.mockResolvedValue(undefined);
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: `clear` leaves a queued
  // `mockResolvedValueOnce` behind for the next test in the file.
  vi.resetAllMocks();
});

describe('cancel stream: a repeated request must not cancel twice', () => {
  it('answers the first request 200 and the second 409 once the write is visible', async () => {
    findUnique
      .mockResolvedValueOnce(activeStream())
      .mockResolvedValueOnce(cancelledStream());
    cancelOnChain.mockResolvedValue('tx_first');
    markCancelled.mockResolvedValue(undefined);

    const first = makeRes();
    const second = makeRes();

    await cancelStreamHandler(makeReq(), first);
    await cancelStreamHandler(makeReq(), second);

    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.json).toHaveBeenCalledWith({ txHash: 'tx_first', status: 'CANCELLED' });

    expect(second.status).toHaveBeenCalledWith(409);
    expect(second.json).toHaveBeenCalledWith(
      errorBody('CONFLICT', 'Stream is already cancelled or completed'),
    );
  });

  it('broadcasts the cancellation on-chain exactly once across two sequential requests', async () => {
    findUnique
      .mockResolvedValueOnce(activeStream())
      .mockResolvedValueOnce(cancelledStream());
    cancelOnChain.mockResolvedValue('tx_first');
    markCancelled.mockResolvedValue(undefined);

    await cancelStreamHandler(makeReq(), makeRes());
    await cancelStreamHandler(makeReq(), makeRes());

    // The point of the 409: a client that retries a cancel it already
    // succeeded with must not move money twice.
    expect(cancelOnChain).toHaveBeenCalledTimes(1);
    expect(cancelOnChain).toHaveBeenCalledWith(...relayArgs(123n));
    expect(markCancelled).toHaveBeenCalledTimes(1);
  });

  it('still answers 409 when the retry carries no senderSecret at all', async () => {
    // Status is decided before the body is read, so a client that lost the
    // original response can learn "it already happened" without resending
    // its signing key.
    findUnique.mockResolvedValue(cancelledStream());

    const res = makeRes();
    await cancelStreamHandler(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(cancelOnChain).not.toHaveBeenCalled();
  });

  it('lets the loser of two simultaneous requests read the winner write', async () => {
    // Both handlers start together. The loser's lookup is made to wait until
    // the winner's write has landed, which is the serialization Prisma gives
    // two overlapping POSTs on one row, and then it sees an inactive stream.
    const writeLanded = deferred<void>();

    findUnique
      .mockResolvedValueOnce(activeStream())
      .mockImplementationOnce(async () => {
        await writeLanded.promise;
        return cancelledStream();
      });
    cancelOnChain.mockResolvedValue('tx_race');
    markCancelled.mockImplementation(async () => {
      writeLanded.resolve();
    });

    const winner = makeRes();
    const loser = makeRes();

    await Promise.all([
      cancelStreamHandler(makeReq(), winner),
      cancelStreamHandler(makeReq(), loser),
    ]);

    expect(winner.status).toHaveBeenCalledWith(200);
    expect(loser.status).toHaveBeenCalledWith(409);
    expect(cancelOnChain).toHaveBeenCalledTimes(1);
  });
});

describe('cancel stream: a completed stream is not a cancellable one', () => {
  it.each([
    ['COMPLETED', 'a stream that ran to term'],
    ['CANCELLED', 'a stream cancelled earlier'],
    ['PAUSED', 'a stream that is paused'],
  ])('refuses %s (%s) with 409 and touches nothing', async (status) => {
    findUnique.mockResolvedValue(activeStream({ isActive: false, status }));

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('CONFLICT', 'Stream is already cancelled or completed'),
    );
    expect(cancelOnChain).not.toHaveBeenCalled();
    expect(markCancelled).not.toHaveBeenCalled();
  });

  it('treats isActive as the liveness signal rather than the status label', async () => {
    // Pinning which of the two representations the route trusts, so a later
    // change to either has to be a deliberate one.
    findUnique.mockResolvedValue(activeStream({ isActive: false, status: 'ACTIVE' }));
    const inactive = makeRes();
    await cancelStreamHandler(makeReq(), inactive);
    expect(inactive.status).toHaveBeenCalledWith(409);

    vi.resetAllMocks();
    findUnique.mockResolvedValue(activeStream({ isActive: true, status: 'COMPLETED' }));
    cancelOnChain.mockResolvedValue('tx_flagged');
    markCancelled.mockResolvedValue(undefined);
    const flagged = makeRes();
    await cancelStreamHandler(makeReq(), flagged);
    expect(flagged.status).toHaveBeenCalledWith(200);
  });
});

describe('cancel stream: streamId boundary inputs', () => {
  it('rejects an empty path segment with 400 MISSING_STREAM_ID before any read', async () => {
    const res = makeRes();
    await cancelStreamHandler(makeReq({ params: { streamId: '' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('MISSING_STREAM_ID', 'Missing streamId parameter'),
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['whitespace only', '   '],
    ['not decimal', 'abc'],
    ['negative', '-1'],
    ['a float', '12.5'],
    ['a signed exponent', '1e3'],
    ['a hex literal', '0x7b'],
  ])('rejects a streamId that is %s with 400 INVALID_STREAM_ID', async (_label, streamId) => {
    const res = makeRes();
    await cancelStreamHandler(makeReq({ params: { streamId } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('INVALID_STREAM_ID', 'Invalid streamId parameter'),
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts stream 0, the smallest legal u64', async () => {
    findUnique.mockResolvedValue(activeStream({ streamId: 0n }));
    cancelOnChain.mockResolvedValue('tx_zero');
    markCancelled.mockResolvedValue(undefined);

    const res = makeRes();
    await cancelStreamHandler(makeReq({ params: { streamId: '0' } }), res);

    // 0 is falsy, which is the case an `if (!streamId)` guard gets wrong.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(cancelOnChain).toHaveBeenCalledWith(...relayArgs(0n));
  });

  it('keeps precision above Number.MAX_SAFE_INTEGER', async () => {
    const huge = '9007199254740993'; // 2^53 + 1
    findUnique.mockResolvedValue(activeStream({ streamId: BigInt(huge) }));
    cancelOnChain.mockResolvedValue('tx_huge');
    markCancelled.mockResolvedValue(undefined);

    const res = makeRes();
    await cancelStreamHandler(makeReq({ params: { streamId: huge } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(cancelOnChain).toHaveBeenCalledWith(...relayArgs(BigInt(huge)));
  });

  it('looks the stream up by the parsed bigint, never the raw string', async () => {
    findUnique.mockResolvedValue(null);

    const res = makeRes();
    await cancelStreamHandler(makeReq({ params: { streamId: '007' } }), res);

    expect(findUnique).toHaveBeenCalledWith({ where: { streamId: 7n } });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(errorBody('NOT_FOUND', 'Stream not found'));
  });
});

describe('cancel stream: request-body taxonomy', () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(activeStream());
  });

  it.each([
    ['a string', 'SABC123'],
    ['empty', ''],
    ['null', null],
    ['a number', 12345],
    ['an array', ['SABC123']],
    ['a boolean', true],
  ])('refuses a legacy senderSecret that is %s with 400', async (_label, _secret) => {
    cancelOnChain.mockResolvedValue('tx_unsent');

    const res = makeRes();
    await cancelStreamHandler(makeReq({ body: { senderSecret: _secret } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(firstError(res).code).toBe('SENDER_SECRET_REMOVED');
    expect(cancelOnChain).not.toHaveBeenCalled();
    expect(markCancelled).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['blank', '   '],
    ['a number', 12345],
    ['an array', ['AAAAAGV1nQJ2Z3F0']],
    ['a boolean', true],
  ])('rejects a signedXdr that is %s with 400 MISSING_SIGNED_XDR', async (_label, signedXdr) => {
    const res = makeRes();
    await cancelStreamHandler(makeReq({ body: { signedXdr } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'MISSING_SIGNED_XDR',
        message:
          'signedXdr is required: sign the cancel transaction from POST /v1/streams/simulate and send the base64 envelope.',
      },
    });
    expect(cancelOnChain).not.toHaveBeenCalled();
  });

  it('reads the body defensively when there is no body at all', async () => {
    const res = makeRes();
    await cancelStreamHandler(makeReq({ body: undefined as never }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cancelOnChain).not.toHaveBeenCalled();
  });

  it('maps an envelope rejection to its own 400 code instead of a generic 500', async () => {
    // The wallet signed the wrong transaction. That is the caller's input to
    // fix, so it must not read as a server fault worth retrying.
    cancelOnChain.mockRejectedValue(
      new ApiError(400, 'SIGNED_TX_MISMATCH', 'The transaction is not a `cancel_stream` call.'),
    );

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('SIGNED_TX_MISMATCH', 'The transaction is not a `cancel_stream` call.'),
    );
    expect(markCancelled).not.toHaveBeenCalled();
  });

  it('maps every other broadcast failure to 500 and writes nothing', async () => {
    cancelOnChain.mockRejectedValue(new Error('tx_fail_post_submission'));

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.'),
    );
    expect(markCancelled).not.toHaveBeenCalled();
  });

  it('answers 500 when the on-chain cancel succeeded but the DB write failed', async () => {
    // The money has moved and the row still says active. Pinning the 500 so
    // that inconsistency surfaces as an error a caller will retry rather
    // than a success it will not.
    cancelOnChain.mockResolvedValue('tx_moved');
    markCancelled.mockRejectedValue(new Error('connection lost'));

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(cancelOnChain).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.'),
    );
  });

  it('answers 500 when the lookup itself fails, not a 404 for an unknown stream', async () => {
    findUnique.mockRejectedValue(new Error('db down'));

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      errorBody('INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.'),
    );
  });
});

describe('cancel stream: which guard answers first', () => {
  it.each([
    ['a missing stream', null, 404],
    ["someone else's active stream", { sender: 'GOTHER', isActive: true, status: 'ACTIVE' }, 403],
    [
      "someone else's inactive stream",
      { sender: 'GOTHER', isActive: false, status: 'CANCELLED' },
      403,
    ],
    [
      'an inactive stream',
      { sender: SENDER, isActive: false, status: 'CANCELLED' },
      409,
    ],
  ])('reports the stream state over the request body: %s', async (_label, row, expected) => {
    findUnique.mockResolvedValue(row);

    const res = makeRes();
    await cancelStreamHandler(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(expected);
    expect(cancelOnChain).not.toHaveBeenCalled();
  });

  it('calls the on-chain cancel only for the sender of an active stream', async () => {
    stubHappyPath('tx_ok');

    const res = makeRes();
    await cancelStreamHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(cancelOnChain).toHaveBeenCalledWith(...relayArgs(123n));
    expect(markCancelled).toHaveBeenCalledWith(123n, 'tx_ok');
  });
});
