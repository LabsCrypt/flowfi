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
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
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
  });

  afterEach(() => {
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.KEEPER_SECRET_KEY;
    delete process.env.SOROBAN_RPC_URL;
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
  });

  describe('chain reads', () => {
    it.skip('verifies mock server is called', async () => {
      const { getStreamFromChain } = await importService();
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(nativeToScVal(99n, { type: 'i128' }))
      );
      
      await getStreamFromChain(1);
      
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

      await expect(getStreamFromChain(7)).resolves.toEqual({
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

      await expect(getStreamFromChain(8)).resolves.toBeNull();
    });

    it.skip('decodes getClaimableFromChain response', async () => {
      const { getClaimableFromChain } = await importService();

      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess(nativeToScVal(99n, { type: 'i128' }))
      );

      await expect(getClaimableFromChain(9)).resolves.toBe('99');
    });

    it('returns null when getClaimableFromChain decoding fails', async () => {
      const { getClaimableFromChain } = await importService();

      mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess(nativeToScVal(true)));

      await expect(getClaimableFromChain(10)).resolves.toBeNull();
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

      await expect(topUpStream(1, 100n, Keypair.random().publicKey())).rejects.toThrow(
        'KEEPER_SECRET_KEY not configured'
      );
      expect(mocks.server.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
