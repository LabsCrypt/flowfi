/**
 * Wallet-signed cancel envelope (issue #1845).
 *
 * The backend no longer receives a user secret key, so the cancel it relays is
 * built and signed by the wallet and merely *validated* here. That validation is
 * the security boundary: the controller writes the returned hash into the
 * database as proof that this sender cancelled this stream, so an envelope that
 * is somebody else's transaction — or not a cancel at all — must be rejected
 * before anything reaches the network.
 *
 * Each case builds a real envelope with the same SDK call the service uses
 * (`new Contract(id).call(...)`) and feeds it to the pure inspector, which does
 * no RPC and no signing.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { ApiError } from '../src/lib/api-error.js';
import {
  inspectSignedCancelEnvelope,
  submitContractCall,
} from '../src/services/sorobanService.js';

const CONTRACT_ID = StellarSdk.StrKey.encodeContract(randomBytes(32));
const OTHER_CONTRACT_ID = StellarSdk.StrKey.encodeContract(randomBytes(32));
const STREAM_ID = 42n;

const sender = StellarSdk.Keypair.random();
const stranger = StellarSdk.Keypair.random();

function cancelArgs(
  address: string,
  streamId: StellarSdk.xdr.ScVal = StellarSdk.nativeToScVal(STREAM_ID, { type: 'u64' }),
): StellarSdk.xdr.ScVal[] {
  return [new StellarSdk.Address(address).toScVal(), streamId];
}

interface CancelShape {
  contractId?: string;
  method?: string;
  args?: StellarSdk.xdr.ScVal[];
  source?: StellarSdk.Keypair;
  signer?: StellarSdk.Keypair;
  extraOperations?: unknown[];
  sign?: boolean;
}

/** A wallet-built, wallet-signed `cancel_stream` envelope. */
function envelopeFor(shape: CancelShape = {}): string {
  const source = shape.source ?? sender;
  const operation = new StellarSdk.Contract(shape.contractId ?? CONTRACT_ID).call(
    shape.method ?? 'cancel_stream',
    ...(shape.args ?? cancelArgs(source.publicKey())),
  );

  const builder = new StellarSdk.TransactionBuilder(new StellarSdk.Account(source.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(300);

  // SDK 17 has two operation types: `Operation.manageData` still returns the
  // legacy shape while `Contract.call` returns the generated one, and the
  // builder accepts both.
  for (const extra of shape.extraOperations ?? []) {
    builder.addOperation(extra as Parameters<typeof builder.addOperation>[0]);
  }

  const built = builder.build();
  if (shape.sign !== false) built.sign(shape.signer ?? source);
  return built.toXDR();
}

function expectError(rawXdr: string, code: string, details?: unknown): ApiError {
  let thrown: unknown;
  try {
    inspectSignedCancelEnvelope(rawXdr, {
      streamId: STREAM_ID,
      senderAddress: sender.publicKey(),
    });
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.statusCode).toBe(400);
  expect(error.code).toBe(code);
  if (details !== undefined) expect(error.details).toEqual(details);
  return error;
}

beforeAll(() => {
  vi.stubEnv('STREAM_CONTRACT_ID', CONTRACT_ID);
  vi.stubEnv('STELLAR_NETWORK', 'testnet');
});

describe('accepts the envelope the cancel flow relays', () => {
  it('returns the wallet-signed cancel of the caller’s own stream', () => {
    const raw = envelopeFor();
    const tx = inspectSignedCancelEnvelope(raw, {
      streamId: STREAM_ID,
      senderAddress: sender.publicKey(),
    });

    expect(tx).toBeInstanceOf(StellarSdk.Transaction);
    expect(tx.source).toBe(sender.publicKey());
    expect(tx.operations).toHaveLength(1);
    // Round-trips to the exact bytes the wallet signed.
    expect(tx.toXDR()).toBe(raw);
  });
});

describe('rejects a malformed or non-cancel envelope as SIGNED_TX_INVALID', () => {
  it('rejects an empty or non-string XDR', () => {
    expectError('', 'SIGNED_TX_INVALID');
    expectError('   ', 'SIGNED_TX_INVALID');
    expectError(undefined as unknown as string, 'SIGNED_TX_INVALID');
  });

  it('rejects XDR that is not a transaction envelope', () => {
    expectError('not-even-base64-xdr', 'SIGNED_TX_INVALID');
  });

  it('rejects an envelope the wallet never signed', () => {
    const error = expectError(envelopeFor({ sign: false }), 'SIGNED_TX_INVALID');
    expect(error.message).toMatch(/no signatures/i);
  });

  it('rejects a transaction whose only operation is not a contract call', () => {
    const built = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(sender.publicKey(), '0'),
      { fee: '100', networkPassphrase: StellarSdk.Networks.TESTNET },
    )
      .addOperation(StellarSdk.Operation.manageData({ name: 'memo', value: 'cancel me' }))
      .setTimeout(300)
      .build();
    built.sign(sender);

    const error = expectError(built.toXDR(), 'SIGNED_TX_INVALID');
    expect(error.message).toMatch(/contract invocation/i);
  });

  it('rejects more than one operation, however innocent the extras look', () => {
    const extra = StellarSdk.Operation.manageData({ name: 'memo', value: 'x' });
    expectError(envelopeFor({ extraOperations: [extra] }), 'SIGNED_TX_INVALID');

    const secondCancel = new StellarSdk.Contract(CONTRACT_ID).call(
      'cancel_stream',
      ...cancelArgs(sender.publicKey()),
    );
    expectError(envelopeFor({ extraOperations: [secondCancel] }), 'SIGNED_TX_INVALID');
  });
});

describe('rejects a right-shaped envelope aimed at something else as SIGNED_TX_MISMATCH', () => {
  it('rejects a cancel of another stream', () => {
    expectError(
      envelopeFor({
        args: cancelArgs(sender.publicKey(), StellarSdk.nativeToScVal(1337n, { type: 'u64' })),
      }),
      'SIGNED_TX_MISMATCH',
      { expected: '42', actual: '1337' },
    );
  });

  it('rejects a stream id encoded as a type the contract does not take', () => {
    expectError(
      envelopeFor({
        args: cancelArgs(sender.publicKey(), StellarSdk.nativeToScVal(42, { type: 'i32' })),
      }),
      'SIGNED_TX_MISMATCH',
      { expected: '42', actual: 'scvI32' },
    );
  });

  it('rejects a cancel that authorizes a different sender', () => {
    expectError(envelopeFor({ args: cancelArgs(stranger.publicKey()) }), 'SIGNED_TX_MISMATCH', {
      expected: sender.publicKey(),
      actual: stranger.publicKey(),
    });
  });

  it('rejects another function on the stream contract', () => {
    expectError(envelopeFor({ method: 'pause_stream' }), 'SIGNED_TX_MISMATCH', {
      expected: 'cancel_stream',
      actual: 'pause_stream',
    });
  });

  it('rejects a different contract', () => {
    expectError(envelopeFor({ contractId: OTHER_CONTRACT_ID }), 'SIGNED_TX_MISMATCH', {
      expected: CONTRACT_ID,
      actual: OTHER_CONTRACT_ID,
    });
  });

  it('rejects a transaction funded by an account other than the caller', () => {
    // The operation still authorizes the caller, so only the source account
    // distinguishes this from a legitimate cancel — and a transaction the
    // caller did not fund cannot be recorded as their cancellation.
    expectError(
      envelopeFor({ source: stranger, signer: stranger, args: cancelArgs(sender.publicKey()) }),
      'SIGNED_TX_MISMATCH',
      { expected: sender.publicKey(), actual: stranger.publicKey() },
    );
  });

  it('rejects a cancel_stream call with the wrong arity', () => {
    expectError(
      envelopeFor({ args: [new StellarSdk.Address(sender.publicKey()).toScVal()] }),
      'SIGNED_TX_MISMATCH',
      { args: 1 },
    );
  });
});

describe('#1845 the service cannot sign a user action with a supplied secret', () => {
  it('submitContractCall takes no senderSecret parameter', () => {
    expect(submitContractCall.length).toBe(2);
  });

  it('refuses to sign anything when no keeper key is configured', async () => {
    vi.stubEnv('KEEPER_SECRET_KEY', '');
    await expect(
      submitContractCall('cancel_stream', cancelArgs(sender.publicKey())),
    ).rejects.toThrow(/KEEPER_SECRET_KEY/);
  });
});
