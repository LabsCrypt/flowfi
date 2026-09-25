import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@stellar/stellar-sdk', () => {
  class FakeAccount {
    constructor(
      public accountId: string,
      public seq: string,
    ) {}
  }
  class FakeContract {
    constructor(public contractId: string) {}
    call(method: string, ...args: unknown[]) {
      return { method, args, contractId: this.contractId };
    }
  }
  class FakeTx {
    constructor(public xdr: string) {}
    toXDR() {
      return this.xdr;
    }
    sign() {}
  }
  class FakeBuilder {
    private ops: unknown[] = [];
    constructor(
      public source: FakeAccount,
      public opts: unknown,
    ) {}
    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }
    setTimeout(_t: number) {
      return this;
    }
    build() {
      const op = this.ops[0] as { method?: string };
      return new FakeTx(`unsigned:${op?.method ?? 'unknown'}`);
    }
    static fromXDR(xdr: string) {
      return new FakeTx(xdr);
    }
  }
  return {
    Account: FakeAccount,
    Contract: FakeContract,
    TransactionBuilder: FakeBuilder,
    Keypair: {
      fromSecret: (secret: string) => ({
        publicKey: () => `G${secret.slice(1, 8)}`,
        sign: () => {},
      }),
    },
    Address: class {},
    nativeToScVal: (v: unknown) => ({ scv: String(v) }),
    scValToNative: (v: unknown) => v,
    rpc: {
      Server: class {
        async simulateTransaction() {
          return { minResourceFee: '100', assembledTx: new FakeTx('assembled:tx') };
        }
        async sendTransaction() {
          return { hash: 'txhash123' };
        }
      },
      assembleTransaction: async (tx: FakeTx) => tx,
    },
  };
});

vi.mock('@stellar/freighter-api', () => ({
  requestAccess: async () => ({ address: 'GFREIGHTER' }),
  signTransaction: async (xdr: string) => `signed:${xdr}`,
}));

import { FlowFiClient } from '../src/client.js';
import {
  applyFeeBuffer,
  buildCancelXdr,
  buildCloseXdr,
  buildCreateStreamXdr,
  buildTopUpXdr,
  buildWithdrawXdr,
  simulateAndAssemble,
} from '../src/builder.js';
import { CustomSigner, KeypairSigner, FreighterSigner } from '../src/signers/index.js';

const CONFIG = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'CCONTRACT',
};

function mockRpc() {
  return {
    async simulateTransaction() {
      return {
        minResourceFee: '100',
        assembledTx: { toXDR: () => 'assembled:tx' },
      };
    },
    sent: [] as string[],
    async sendTransaction(xdr: string) {
      this.sent.push(xdr);
      return { transactionHash: 'hash-1', returnValue: 42n };
    },
    async getStream() {
      return null;
    },
    async getClaimableAmount() {
      return 10n;
    },
    async getStreamIdForTx() {
      return 7n;
    },
  };
}

describe('applyFeeBuffer', () => {
  it('pads the simulated fee and rounds up', () => {
    expect(applyFeeBuffer(100n, 1.25)).toBe('125');
    expect(applyFeeBuffer(101n, 1.2)).toBe('122'); // 121.2 -> 122
  });

  it('rejects multipliers below 1', () => {
    expect(() => applyFeeBuffer(100n, 0.9)).toThrow();
  });
});

describe('transaction builders', () => {
  const base = {
    sourceAccount: 'GSOURCE',
    contractId: CONFIG.contractId,
    networkPassphrase: CONFIG.networkPassphrase,
  };

  it('builds create_stream without cliff', async () => {
    const xdr = await buildCreateStreamXdr(
      { sender: 'GS', recipient: 'GR', tokenAddress: 'CT', amount: 1000n, duration: 100 },
      base,
    );
    expect(xdr).toContain('create_stream');
  });

  it('builds cliff variant when cliffDuration is set', async () => {
    const xdr = await buildCreateStreamXdr(
      { sender: 'GS', recipient: 'GR', tokenAddress: 'CT', amount: 1000n, duration: 100, cliffDuration: 10 },
      base,
    );
    expect(xdr).toContain('create_stream_with_cliff');
  });

  it('builds withdraw / top-up / cancel / close envelopes', async () => {
    expect(await buildWithdrawXdr(1n, 'GR', base)).toContain('withdraw');
    expect(await buildTopUpXdr(1n, 'GS', 5n, base)).toContain('top_up_stream');
    expect(await buildCancelXdr(1n, 'GS', base)).toContain('cancel_stream');
    expect(await buildCloseXdr(1n, 'GS', base)).toContain('close_stream');
  });

  it('simulateAndAssemble attaches footprint and pads fees', async () => {
    const rpcClient = mockRpc();
    const out = await simulateAndAssemble({
      unsignedXdr: 'unsigned:withdraw',
      networkPassphrase: CONFIG.networkPassphrase,
      rpcUrl: CONFIG.rpcUrl,
      feeBufferMultiplier: 1.25,
      rpcClient,
    });
    expect(out.assembledXdr).toBe('assembled:tx');
    expect(out.resourceFee).toBe('125');
  });

  it('simulateAndAssemble surfaces simulation errors', async () => {
    const failing = { simulateTransaction: async () => ({ error: 'bad footprint' }) };
    await expect(
      simulateAndAssemble({
        unsignedXdr: 'unsigned:x',
        networkPassphrase: CONFIG.networkPassphrase,
        rpcUrl: CONFIG.rpcUrl,
        rpcClient: failing,
      }),
    ).rejects.toThrow(/simulation failed/);
  });
});

describe('signers', () => {
  it('CustomSigner delegates to the callback', async () => {
    const signer = new CustomSigner('GCUSTOM', async (xdr) => `signed:${xdr}`);
    expect(signer.getPublicKey()).toBe('GCUSTOM');
    expect(await signer.signTransaction('env')).toBe('signed:env');
  });

  it('KeypairSigner rejects non-secret input', () => {
    expect(() => new KeypairSigner('GNOTSECRET')).toThrow();
  });

  it('KeypairSigner derives a public key', async () => {
    const signer = new KeypairSigner('SSECRET123');
    expect(await signer.getPublicKey()).toContain('G');
  });

  it('FreighterSigner works in the browser shim', async () => {
    const signer = new FreighterSigner();
    expect(await signer.getPublicKey()).toBe('GFREIGHTER');
    expect(await signer.signTransaction('env')).toContain('signed:');
  });
});

describe('FlowFiClient', () => {
  let rpcClient: ReturnType<typeof mockRpc>;

  beforeEach(() => {
    rpcClient = mockRpc();
  });

  it('creates a stream in 3 lines via an injected signer', async () => {
    const client = new FlowFiClient(CONFIG, { rpcClient });
    const signer = new CustomSigner('GSENDER', async (xdr) => `signed:${xdr}`);
    const res = await client.createStream(
      { sender: 'GSENDER', recipient: 'GRECIP', tokenAddress: 'CTOKEN', amount: 1000n, duration: 100 },
      signer,
    );
    expect(res.streamId).toBe(7n);
    expect(res.transactionHash).toBe('hash-1');
    expect(rpcClient.sent[0]).toContain('signed:');
  });

  it('validates create params', async () => {
    const client = new FlowFiClient(CONFIG, { rpcClient });
    const signer = new CustomSigner('GS', async (x) => x);
    await expect(
      client.createStream({ sender: 'GS', recipient: 'GR', tokenAddress: 'CT', amount: 0n, duration: 10 }, signer),
    ).rejects.toThrow();
    await expect(
      client.createStream({ sender: 'GS', recipient: 'GR', tokenAddress: 'CT', amount: 10n, duration: 0 }, signer),
    ).rejects.toThrow();
  });

  it('batchWithdraw signs once per stream', async () => {
    const client = new FlowFiClient(CONFIG, { rpcClient });
    const signer = new CustomSigner('GRECIP', async (x) => `signed:${x}`);
    const out = await client.batchWithdraw([1n, 2n], signer);
    expect(out).toHaveLength(2);
    expect(rpcClient.sent).toHaveLength(2);
  });

  it('topUp / cancel / close submit signed envelopes', async () => {
    const client = new FlowFiClient(CONFIG, { rpcClient });
    const signer = new CustomSigner('GS', async (x) => `signed:${x}`);
    await expect(client.topUpStream(1n, 5n, signer)).resolves.toMatchObject({ transactionHash: 'hash-1' });
    await expect(client.cancelStream(1n, signer)).resolves.toMatchObject({ transactionHash: 'hash-1' });
    await expect(client.closeStream(1n, signer)).resolves.toMatchObject({ transactionHash: 'hash-1' });
    await expect(client.topUpStream(1n, 0n, signer)).rejects.toThrow();
  });

  it('reads stream + claimable without signing', async () => {
    const client = new FlowFiClient(CONFIG, { rpcClient });
    expect(await client.getStream(1n)).toBeNull();
    expect(await client.getClaimableAmount(1n)).toBe(10n);
  });

  it('requires constructor config', () => {
    expect(() => new FlowFiClient({ rpcUrl: '', networkPassphrase: '', contractId: '' })).toThrow();
  });
});
