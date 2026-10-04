import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  FeeBumpTransaction,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

const mocks = vi.hoisted(() => ({
  server: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
  },
  assembleTransaction: vi.fn(),
}));

// Only `assembleTransaction` is stubbed: it is the one call that would demand a
// fully-populated restore preamble. Everything else, including
// `Api.isSimulationError`, runs for real so the fixtures are realistic.
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: { ...actual.rpc, assembleTransaction: mocks.assembleTransaction },
  };
});

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
const tokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2));
const senderKp = Keypair.random();
const recipientKp = Keypair.random();

/** A SorobanResources-bearing success response with a known footprint. */
function simulationSuccess(
  overrides: Partial<rpc.Api.SimulateTransactionSuccessResponse> = {},
): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: 'sim-1',
    latestLedger: 482_910,
    events: [],
    _parsed: true,
    minResourceFee: '1000',
    transactionData: new SorobanDataBuilder().setResources(123_456, 111, 222),
    result: { auth: [], retval: nativeToScVal(BigInt('0'), { type: 'i128' }) },
    ...overrides,
  } as rpc.Api.SimulateTransactionSuccessResponse;
}

function simulationError(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: 'sim-1',
    latestLedger: 482_910,
    events: [],
    _parsed: true,
    error,
  } as rpc.Api.SimulateTransactionErrorResponse;
}

/**
 * Extract the invoke args from the transaction handed to the RPC mock.
 *
 * `Transaction.operations` exposes marshalled attribute objects, so the
 * contract call is reached via `func.invokeContract()` and its fields are read
 * through `contractAddress()` / `functionName()` / `args()`.
 */
function invokedOps(tx: Transaction): Array<{ contractHex: string; fn: string; args: xdr.ScVal[] }> {
  return tx.operations.map((op) => {
    const ico = (op as unknown as { func: { invokeContract(): InvokeContractArgsLike } }).func.invokeContract();
    return {
      contractHex: Buffer.from(ico.contractAddress().contractId()).toString('hex'),
      fn: ico.functionName(),
      args: ico.args(),
    };
  });
}

/** The marshalled `InvokeContractArgs` shape returned by `func.invokeContract()`. */
interface InvokeContractArgsLike {
  contractAddress(): { contractId(): Uint8Array };
  functionName(): string;
  args(): xdr.ScVal[];
}

/** Hex form of a contract address, for comparison against a StrKey contract. */
function contractHex(address: string): string {
  return Buffer.from(StrKey.decodeContract(address)).toString('hex');
}

/** Decode a returned envelope and assert it carries no signatures. */
function expectUnsignedEnvelope(unsignedXdr: string): xdr.Transaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(unsignedXdr, 'base64');
  expect(envelope.switch().name).toBe('envelopeTypeTx');
  expect(envelope.v1().signatures()).toHaveLength(0);
  return envelope.v1().tx();
}

function lastSimulatedTx(): Transaction {
  return mocks.server.simulateTransaction.mock.calls.at(-1)![0] as Transaction;
}

describe('simulateStreamAction', () => {
  let service: typeof import('../src/services/sorobanService.js');
  let ApiError: typeof import('../src/lib/api-error.js').ApiError;

  beforeAll(async () => {
    process.env.STREAM_CONTRACT_ID = contractId;
    process.env.STREAM_TOKEN_ADDRESS = tokenAddress;
    process.env.SOROBAN_RPC_URL = 'https://rpc.test';
    process.env.STELLAR_NETWORK = 'testnet';
    // Keep the retry budget at zero-retry for transient paths so a fallback
    // assertion does not sit through exponential backoff.
    process.env.SOROBAN_RPC_MAX_RETRIES = '0';

    service = await import('../src/services/sorobanService.js');
    ({ ApiError } = await import('../src/lib/api-error.js'));
    service.setServer(mocks.server as unknown as rpc.Server);
  });

  afterAll(() => {
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.STREAM_TOKEN_ADDRESS;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.SOROBAN_RPC_MAX_RETRIES;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.server.getAccount.mockResolvedValue(new Account(senderKp.publicKey(), '42'));
    mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess());
    // Pass the tx straight through: the returned XDR is then the real,
    // unsigned envelope, which the assertions can decode.
    mocks.assembleTransaction.mockImplementation((tx: Transaction) => ({ build: () => tx }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 503 when the stream contract is not configured', async () => {
    delete process.env.STREAM_CONTRACT_ID;
    try {
      await expect(
        service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '1' }),
      ).rejects.toMatchObject({ status: 503, code: 'contract_not_configured' });
    } finally {
      process.env.STREAM_CONTRACT_ID = contractId;
    }
    expect(mocks.server.simulateTransaction).not.toHaveBeenCalled();
  });

  describe('create', () => {
    it('simulates create_stream with all five args in contract order', async () => {
      await service.simulateStreamAction('create', senderKp.publicKey(), {
        recipient: recipientKp.publicKey(),
        amount: '1000000',
        duration: 3600,
      });

      const [op] = invokedOps(lastSimulatedTx());
      expect(op!.contractHex).toBe(contractHex(contractId));
      expect(op!.fn).toBe('create_stream');
      expect(Address.fromScVal(op!.args[0]!).toString()).toBe(senderKp.publicKey());
      expect(Address.fromScVal(op!.args[1]!).toString()).toBe(recipientKp.publicKey());
      expect(Address.fromScVal(op!.args[2]!).toString()).toBe(tokenAddress);
      expect(service.decodeI128(op!.args[3]!)).toBe('1000000');
      expect(op!.args[4]!.u64().toString()).toBe('3600');
    });

    it('prefers params.tokenAddress over the configured default', async () => {
      const otherToken = StrKey.encodeContract(Buffer.alloc(32, 9));
      await service.simulateStreamAction('create', senderKp.publicKey(), {
        recipient: recipientKp.publicKey(),
        amount: '500',
        duration: 60,
        tokenAddress: otherToken,
      });

      const [op] = invokedOps(lastSimulatedTx());
      expect(Address.fromScVal(op!.args[2]!).toString()).toBe(otherToken);
    });

    it('rejects a malformed recipient address', async () => {
      await expect(
        service.simulateStreamAction('create', senderKp.publicKey(), {
          recipient: 'not-an-address',
          amount: '100',
          duration: 60,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });

    it('rejects a zero amount', async () => {
      await expect(
        service.simulateStreamAction('create', senderKp.publicKey(), {
          recipient: recipientKp.publicKey(),
          amount: '0',
          duration: 60,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });

    it('rejects a non-positive or fractional duration', async () => {
      for (const duration of [0, -1, 1.5]) {
        await expect(
          service.simulateStreamAction('create', senderKp.publicKey(), {
            recipient: recipientKp.publicKey(),
            amount: '100',
            duration,
          }),
        ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
      }
    });
  });

  describe('withdraw / cancel / top_up', () => {
    it('simulates withdraw(sender, streamId)', async () => {
      await service.simulateStreamAction('withdraw', recipientKp.publicKey(), {
        streamId: '42',
      });

      const [op] = invokedOps(lastSimulatedTx());
      expect(op!.fn).toBe('withdraw');
      expect(Address.fromScVal(op!.args[0]!).toString()).toBe(recipientKp.publicKey());
      expect(op!.args[1]!.u64().toString()).toBe('42');
    });

    it('simulates cancel_stream(sender, streamId)', async () => {
      await service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '7' });

      const [op] = invokedOps(lastSimulatedTx());
      expect(op!.fn).toBe('cancel_stream');
      expect(op!.args[1]!.u64().toString()).toBe('7');
    });

    it('simulates top_up_stream(sender, streamId, amount)', async () => {
      await service.simulateStreamAction('top_up', senderKp.publicKey(), {
        streamId: '7',
        amount: '2500',
      });

      const [op] = invokedOps(lastSimulatedTx());
      expect(op!.fn).toBe('top_up_stream');
      expect(op!.args[1]!.u64().toString()).toBe('7');
      expect(service.decodeI128(op!.args[2]!)).toBe('2500');
    });

    it('rejects a non-numeric streamId', async () => {
      await expect(
        service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '12abc' }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });

    it('rejects a missing streamId', async () => {
      await expect(
        service.simulateStreamAction('cancel', senderKp.publicKey(), {}),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });
  });

  describe('batch_withdraw', () => {
    it('packs every stream into one transaction as separate withdraw ops', async () => {
      await service.simulateStreamAction('batch_withdraw', recipientKp.publicKey(), {
        streamIds: ['1', '2', '3'],
      });

      const ops = invokedOps(lastSimulatedTx());
      expect(ops).toHaveLength(3);
      expect(ops.map((o) => o.fn)).toEqual(['withdraw', 'withdraw', 'withdraw']);
      expect(ops.map((o) => o.args[1]!.u64().toString())).toEqual(['1', '2', '3']);
    });

    it('rejects a batch above the per-transaction cap', async () => {
      const streamIds = Array.from({ length: 11 }, (_, i) => String(i + 1));
      await expect(
        service.simulateStreamAction('batch_withdraw', recipientKp.publicKey(), { streamIds }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });

    it('rejects an empty batch', async () => {
      await expect(
        service.simulateStreamAction('batch_withdraw', recipientKp.publicKey(), { streamIds: [] }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    });
  });

  describe('response envelope', () => {
    it('returns unsigned, decodable XDR that wallets can sign', async () => {
      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '7',
      });

      const tx = expectUnsignedEnvelope(result.unsignedXdr);
      expect(tx.operations()).toHaveLength(1);
    });

    it('builds the transaction from the sender real account, not a placeholder', async () => {
      await service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '7' });

      const tx = lastSimulatedTx();
      expect(tx.source).toBe(senderKp.publicKey());
      // Account sequence 42, bumped to 43 by TransactionBuilder, so the
      // envelope carries the sender's real sequence and is directly signable.
      expect(tx.sequence).toBe('43');
    });

    it('falls back to a placeholder source account when getAccount fails', async () => {
      // Non-transient, so the retry wrapper does not re-attempt.
      mocks.server.getAccount.mockRejectedValue(new Error('Account not found'));

      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '7',
      });

      expect(lastSimulatedTx().source).not.toBe(senderKp.publicKey());
      // Still returns a signable envelope rather than failing the request.
      expect(expectUnsignedEnvelope(result.unsignedXdr).operations()).toHaveLength(1);
    });

    it('applies the 15% fee buffer over the reported minResourceFee', async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess({ minResourceFee: '1000' }),
      );

      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '7',
      });

      expect(result.minResourceFee).toBe('1000');
      expect(result.recommendedFee).toBe('1150');
    });

    it('reports the CPU and write footprints from the simulation', async () => {
      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '7',
      });

      expect(result.cpuInstructions).toBe(123_456);
      expect(result.memoryBytes).toBe(222);
    });

    it('stamps the footprint validity window onto the current ledger', async () => {
      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '7',
      });

      expect(result.expiresAtLedger).toBe(482_910 + 10);
    });

    it('decodes an i128 contract return value as a decimal string', async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess({
          result: {
            auth: [],
            retval: nativeToScVal(BigInt('9007199254740'), { type: 'i128' }),
          },
        }),
      );

      const result = await service.simulateStreamAction('withdraw', recipientKp.publicKey(), {
        streamId: '1',
      });

      expect(result.simulatedReturn).toBe('9007199254740');
    });

    it('returns an empty string for a void return', async () => {
      // `result` is absent entirely rather than undefined: a void contract
      // function has no host-function result envelope in the RPC response.
      const voidResponse = { ...simulationSuccess() } as Record<string, unknown>;
      delete voidResponse['result'];
      mocks.server.simulateTransaction.mockResolvedValue(voidResponse);

      const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
        streamId: '1',
      });

      expect(result.simulatedReturn).toBe('');
    });

    it('base64-encodes a non-numeric return so the client can decode it', async () => {
      const address = new Address(recipientKp.publicKey());
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess({ result: { auth: [], retval: address.toScVal() } }),
      );

      const result = await service.simulateStreamAction('withdraw', recipientKp.publicKey(), {
        streamId: '1',
      });

      expect(Address.fromScVal(xdr.ScVal.fromXDR(Buffer.from(result.simulatedReturn, 'base64'))).toString()).toBe(
        recipientKp.publicKey(),
      );
    });

    it('emits an envelope that round-trips through the SDK parser', async () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      try {
        const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
          streamId: '7',
        });

        // The passphrase is not verifiable from an unsigned envelope, so this
        // asserts structural round-tripping rather than passphrase correctness.
        const parsed = TransactionBuilder.fromXDR(result.unsignedXdr, Networks.PUBLIC);
        expect(parsed).not.toBeInstanceOf(FeeBumpTransaction);
        const tx = parsed as Transaction;
        expect(tx.source).toBe(senderKp.publicKey());
        expect(tx.sequence).toBe('43');
        expect(invokedOps(tx)).toHaveLength(1);
      } finally {
        process.env.STELLAR_NETWORK = 'testnet';
      }
    });
  });

  describe('contract error decoding', () => {
    it('maps a known StreamError code to its message and hint', async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationError('HostError: Error(Contract, #2)'),
      );

      const err = await service
        .simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '999' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({
        status: 400,
        code: 'simulation_failed',
        message: 'Stream not found',
      });
      expect((err as InstanceType<typeof ApiError>).details).toMatchObject({
        action: 'cancel',
        contractErrorCode: 2,
      });
      expect((err as InstanceType<typeof ApiError>).details?.hint).toBeTruthy();
    });

    it('passes through an unrecognised reason when no code can be parsed', async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationError('Host function failed: panic'),
      );

      await expect(
        service.simulateStreamAction('withdraw', recipientKp.publicKey(), { streamId: '1' }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'simulation_failed',
        message: 'Simulation of "withdraw" failed: Host function failed: panic',
      });
    });

    it('never leaks the raw diagnostic for a known code', async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationError('HostError: Error(Contract, #3) diagnostics: sender_not_authorized'),
      );

      await expect(
        service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '1' }),
      ).rejects.toMatchObject({ message: 'Caller is not authorized for this stream' });
    });
  });
});

describe('applyFeeBuffer', () => {
  beforeAll(async () => {
    process.env.STREAM_CONTRACT_ID = contractId;
    process.env.SOROBAN_RPC_URL = 'https://rpc.test';
  });
  afterAll(() => {
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_URL;
  });

  it('adds 15% and rounds up so the result is never short', async () => {
    const { applyFeeBuffer, FEE_BUFFER_PERCENT } = await import('../src/services/sorobanService.js');

    expect(FEE_BUFFER_PERCENT).toBe(15);
    expect(applyFeeBuffer('100')).toBe('115');
    expect(applyFeeBuffer('1000')).toBe('1150');
    expect(applyFeeBuffer('10000')).toBe('11500');
    // 7 * 1.15 = 8.05 -> 8, still strictly greater than the base.
    expect(applyFeeBuffer('7')).toBe('8');
  });

  it('returns at least 1 stroop for a zero fee', async () => {
    const { applyFeeBuffer } = await import('../src/services/sorobanService.js');
    expect(applyFeeBuffer('0')).toBe('1');
    expect(applyFeeBuffer('')).toBe('1');
  });

  it('handles very large fees without losing precision', async () => {
    const { applyFeeBuffer } = await import('../src/services/sorobanService.js');
    // 2^63-1 * 115 / 100 = 10606877842382992178.05 -> floored, and the
    // BigInt math must not round through a float.
    expect(applyFeeBuffer('9223372036854775807')).toBe('10606877842382992178');
  });
});

describe('parseContractErrorCode', () => {
  beforeAll(async () => {
    process.env.STREAM_CONTRACT_ID = contractId;
    process.env.SOROBAN_RPC_URL = 'https://rpc.test';
  });
  afterAll(() => {
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_URL;
  });

  it('reads the modern HostError format', async () => {
    const { parseContractErrorCode } = await import('../src/services/sorobanService.js');
    expect(parseContractErrorCode('HostError: Error(Contract, #7)')).toBe(7);
    expect(parseContractErrorCode('Error(Contract, #12)')).toBe(12);
  });

  it('reads the legacy "contract trapped" format', async () => {
    const { parseContractErrorCode } = await import('../src/services/sorobanService.js');
    expect(parseContractErrorCode('contract trapped: Error(Contract, #4)')).toBe(4);
  });

  it('returns null when there is no code to find', async () => {
    const { parseContractErrorCode } = await import('../src/services/sorobanService.js');
    expect(parseContractErrorCode('tx_bad_auth')).toBeNull();
    expect(parseContractErrorCode('')).toBeNull();
  });
});
