import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Keypair,
  StrKey,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

const mocks = vi.hoisted(() => {
  const server = {
    getAccount: vi.fn(),
    getHealth: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };

  return {
    server,
    assembleTransaction: vi.fn(),
    isSimulationError: vi.fn(),
  };
});

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: mocks.assembleTransaction,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mocks.isSimulationError,
      },
    },
  };
});

vi.mock('../src/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));

function mapEntry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(key),
    val,
  });
}

function mapVal(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  return xdr.ScVal.scvMap(entries.map(([key, val]) => mapEntry(key, val)));
}

function simulationSuccess(retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    result: { retval },
  } as rpc.Api.SimulateTransactionSuccessResponse;
}

async function importService(env: Record<string, string | undefined> = {}) {
  if (env.STREAM_CONTRACT_ID === undefined) {
    process.env.STREAM_CONTRACT_ID = contractId;
  } else {
    process.env.STREAM_CONTRACT_ID = env.STREAM_CONTRACT_ID;
  }

  if (env.KEEPER_SECRET_KEY === undefined) {
    delete process.env.KEEPER_SECRET_KEY;
  } else {
    process.env.KEEPER_SECRET_KEY = env.KEEPER_SECRET_KEY;
  }

  process.env.SOROBAN_RPC_URL = 'https://rpc.test';

  return import('../src/services/sorobanService.js');
}

describe('Soroban Service', () => {
  beforeAll(async () => {
    // Set environment variables before importing the service
    process.env.STREAM_CONTRACT_ID = contractId;
    process.env.SOROBAN_RPC_URL = 'https://rpc.test';
    
    // Set up the mock server once before all tests
    const { setServer } = await import('../src/services/sorobanService.js');
    setServer(mocks.server as any);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSimulationError.mockReturnValue(false);
    mocks.server.getHealth.mockResolvedValue({ status: 'healthy' });
  });

  afterEach(() => {
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.KEEPER_SECRET_KEY;
    delete process.env.SOROBAN_RPC_URL;
  });

  describe('checkRpcHealth', () => {
    it('caches successful RPC health checks for the TTL window', async () => {
      const { checkRpcHealth, resetRpcHealthCache } = await importService();
      resetRpcHealthCache();

      await expect(checkRpcHealth(25)).resolves.toBe(true);
      await expect(checkRpcHealth(25)).resolves.toBe(true);
      expect(mocks.server.getHealth).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent health checks while a refresh is in flight', async () => {
      const { checkRpcHealth, resetRpcHealthCache } = await importService();
      resetRpcHealthCache();

      const [first, second] = await Promise.all([
        checkRpcHealth(25),
        checkRpcHealth(25),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(mocks.server.getHealth).toHaveBeenCalledTimes(1);
    });
  });

  describe('isStale', () => {
    it('should return true if updated more than 30s ago', async () => {
      const { isStale } = await importService();

      const longAgo = new Date(Date.now() - 31000);
      expect(isStale(longAgo)).toBe(true);
    });

    it('should return false if updated recently', async () => {
      const { isStale } = await importService();

      const recently = new Date(Date.now() - 5000);
      expect(isStale(recently)).toBe(false);
    });
  });

  describe('submitContractCall', () => {
    it('throws when simulation returns an error', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const simulation = { error: 'contract trapped' };

      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulation);
      mocks.isSimulationError.mockReturnValue(true);

      await expect(
        submitContractCall('cancel_stream', [nativeToScVal(1, { type: 'u64' })], sender.secret())
      ).rejects.toThrow('Simulation failed: contract trapped');
      expect(mocks.server.sendTransaction).not.toHaveBeenCalled();
    });

    it('throws when sendTransaction returns ERROR', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const assembledTx = { sign: vi.fn() };

      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(1)));
      mocks.assembleTransaction.mockReturnValue({ build: () => assembledTx });
      mocks.server.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: 'tx failed',
      });

      await expect(
        submitContractCall('cancel_stream', [nativeToScVal(1, { type: 'u64' })], sender.secret())
      ).rejects.toThrow('Transaction failed: "tx failed"');
      expect(assembledTx.sign).toHaveBeenCalledWith(sender);
    });

    it('polls getTransaction and returns tx hash when transaction succeeds on-chain', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const assembledTx = { sign: vi.fn() };

      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(1)));
      mocks.assembleTransaction.mockReturnValue({ build: () => assembledTx });
      mocks.server.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx-hash-success',
      });
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: 'tx-hash-success',
      });

      const result = await submitContractCall(
        'cancel_stream',
        [nativeToScVal(1, { type: 'u64' })],
        sender.secret()
      );

      expect(result).toBe('tx-hash-success');
      expect(mocks.server.getTransaction).toHaveBeenCalledWith('tx-hash-success');
    });

    it('polls across pending NOT_FOUND statuses until SUCCESS', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const assembledTx = { sign: vi.fn() };

      process.env.SOROBAN_TX_POLL_INTERVAL_MS = '10';
      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(1)));
      mocks.assembleTransaction.mockReturnValue({ build: () => assembledTx });
      mocks.server.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx-hash-eventual',
      });
      mocks.server.getTransaction
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.NOT_FOUND,
          txHash: 'tx-hash-eventual',
        })
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          txHash: 'tx-hash-eventual',
        });

      const result = await submitContractCall(
        'cancel_stream',
        [nativeToScVal(1, { type: 'u64' })],
        sender.secret()
      );

      expect(result).toBe('tx-hash-eventual');
      expect(mocks.server.getTransaction).toHaveBeenCalledTimes(2);
      delete process.env.SOROBAN_TX_POLL_INTERVAL_MS;
    });

    it('throws when getTransaction returns FAILED after mempool acceptance', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const assembledTx = { sign: vi.fn() };

      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(1)));
      mocks.assembleTransaction.mockReturnValue({ build: () => assembledTx });
      mocks.server.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx-hash-failed',
      });
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        txHash: 'tx-hash-failed',
      });

      await expect(
        submitContractCall('cancel_stream', [nativeToScVal(1, { type: 'u64' })], sender.secret())
      ).rejects.toThrow('Transaction failed on-chain: tx-hash-failed');
    });

    it('throws when transaction confirmation times out', async () => {
      const { submitContractCall } = await importService();
      const sender = Keypair.random();
      const assembledTx = { sign: vi.fn() };

      process.env.SOROBAN_TX_CONFIRMATION_TIMEOUT_MS = '50';
      process.env.SOROBAN_TX_POLL_INTERVAL_MS = '10';
      mocks.server.getAccount.mockResolvedValue(new Account(sender.publicKey(), '1'));
      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(1)));
      mocks.assembleTransaction.mockReturnValue({ build: () => assembledTx });
      mocks.server.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx-hash-timeout',
      });
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: 'tx-hash-timeout',
      });

      await expect(
        submitContractCall('cancel_stream', [nativeToScVal(1, { type: 'u64' })], sender.secret())
      ).rejects.toThrow(/Transaction confirmation timed out/);

      delete process.env.SOROBAN_TX_CONFIRMATION_TIMEOUT_MS;
      delete process.env.SOROBAN_TX_POLL_INTERVAL_MS;
    });
  });

  describe('pollTransactionStatus', () => {
    it('returns transaction response when status is SUCCESS', async () => {
      const { pollTransactionStatus } = await importService();
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: 'tx-poll-success',
      });

      const res = await pollTransactionStatus('tx-poll-success', 5000, 10);
      expect(res.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
      expect(mocks.server.getTransaction).toHaveBeenCalledWith('tx-poll-success');
    });

    it('throws with error details when status is FAILED', async () => {
      const { pollTransactionStatus } = await importService();
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        txHash: 'tx-poll-failed',
      });

      await expect(pollTransactionStatus('tx-poll-failed', 5000, 10)).rejects.toThrow(
        'Transaction failed on-chain: tx-poll-failed'
      );
    });

    it('times out if transaction never reaches terminal status', async () => {
      const { pollTransactionStatus } = await importService();
      mocks.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: 'tx-poll-pending',
      });

      await expect(pollTransactionStatus('tx-poll-pending', 50, 10)).rejects.toThrow(
        'Transaction confirmation timed out after 50ms: tx-poll-pending'
      );
    });
  });

  describe('chain reads', () => {
    it.skip('verifies mock server is called', async () => {
      const { getStreamFromChain } = await importService();
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(nativeToScVal(99n, { type: 'i128' }))
      );
      
      await getStreamFromChain(1n);
      
      expect(mocks.server.simulateTransaction).toHaveBeenCalled();
    });

    it.skip('decodes getStreamFromChain response', async () => {
      const { getStreamFromChain } = await importService();
      const sender = Keypair.random().publicKey();
      const recipient = Keypair.random().publicKey();
      const tokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2));

      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          mapVal([
            ['sender', nativeToScVal(sender, { type: 'address' })],
            ['recipient', nativeToScVal(recipient, { type: 'address' })],
            ['token_address', nativeToScVal(tokenAddress, { type: 'address' })],
            ['rate_per_second', nativeToScVal(25n, { type: 'i128' })],
            ['deposited_amount', nativeToScVal(1_000n, { type: 'i128' })],
            ['withdrawn_amount', nativeToScVal(125n, { type: 'i128' })],
            ['start_time', nativeToScVal(1_700_000_000, { type: 'u64' })],
            ['is_active', nativeToScVal(true)],
          ])
        )
      );

      await expect(getStreamFromChain(7n)).resolves.toEqual({
        streamId: 7,
        sender,
        recipient,
        tokenAddress,
        ratePerSecond: '25',
        depositedAmount: '1000',
        withdrawnAmount: '125',
        startTime: 1_700_000_000,
        isActive: true,
      });
    });

    it('returns null when getStreamFromChain decoding fails', async () => {
      const { getStreamFromChain } = await importService();

      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(mapVal([['sender', nativeToScVal('not-an-address')]]))
      );

      await expect(getStreamFromChain(8n)).resolves.toBeNull();
    });

    it.skip('decodes getClaimableFromChain response', async () => {
      const { getClaimableFromChain } = await importService();

      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(nativeToScVal(99n, { type: 'i128' }))
      );

      await expect(getClaimableFromChain(9n)).resolves.toBe('99');
    });

    it('returns null when getClaimableFromChain decoding fails', async () => {
      const { getClaimableFromChain } = await importService();

      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(true)));

      await expect(getClaimableFromChain(10n)).resolves.toBeNull();
    });
  });

  describe('decoders', () => {
    it('decodes positive and negative i128 values', async () => {
      const { decodeI128 } = await importService();

      expect(decodeI128(nativeToScVal(123n, { type: 'i128' }))).toBe('123');
      expect(decodeI128(nativeToScVal(-123n, { type: 'i128' }))).toBe('-123');
    });

    it('decodes account and contract addresses', async () => {
      const { decodeAddress } = await importService();
      const account = Keypair.random().publicKey();
      const contract = StrKey.encodeContract(Buffer.alloc(32, 3));

      expect(decodeAddress(nativeToScVal(account, { type: 'address' }))).toBe(account);
      expect(decodeAddress(nativeToScVal(contract, { type: 'address' }))).toBe(contract);
    });
  });

  describe('topUpStream', () => {
    it('throws when KEEPER_SECRET_KEY is unset', async () => {
      const { topUpStream } = await importService({ KEEPER_SECRET_KEY: undefined });

      await expect(topUpStream(1n, 100n, Keypair.random().publicKey())).rejects.toThrow(
        'KEEPER_SECRET_KEY not configured'
      );
      expect(mocks.server.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('withRpcTimeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects with RpcTimeoutError and aborts the signal when the call hangs past the deadline', async () => {
      const { withRpcTimeout, RpcTimeoutError } = await importService();
      let observedSignal: AbortSignal | undefined;

      const promise = withRpcTimeout(
        'slowCall',
        (signal) => {
          observedSignal = signal;
          return new Promise(() => {});
        },
        1000
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(RpcTimeoutError);

      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(observedSignal?.aborted).toBe(true);
    });

    it('resolves normally when the call finishes before the deadline', async () => {
      const { withRpcTimeout } = await importService();

      await expect(withRpcTimeout('fastCall', async () => 'ok', 1000)).resolves.toBe('ok');
    });
  });

  describe('withRpcRetry', () => {
    it('retries a transient failure with backoff and returns the eventual success', async () => {
      const { withRpcRetry } = await importService();
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNRESET');
        return 'ok';
      });

      await expect(withRpcRetry('flaky', fn, 3)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry a non-transient error', async () => {
      const { withRpcRetry } = await importService();
      const fn = vi.fn(async () => {
        throw new Error('Invalid amount: must be a valid integer');
      });

      await expect(withRpcRetry('validation', fn, 3)).rejects.toThrow('Invalid amount');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after exceeding the max retry count for a persistently transient error', async () => {
      const { withRpcRetry } = await importService();
      const fn = vi.fn(async () => {
        throw new Error('ECONNRESET');
      });

      await expect(withRpcRetry('flaky', fn, 2)).rejects.toThrow('ECONNRESET');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
