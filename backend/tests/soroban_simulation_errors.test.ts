import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * Failure-path surface of the client-signing simulation (#1755).
 *
 * `tests/stream-simulation.test.ts` proves that a *successful* simulation is
 * assembled correctly and shows one contract error reaching the client. This
 * file pins the parts of the same call that only matter when it goes wrong:
 *
 *   - every `StreamError` code the contract can trap with has a client-facing
 *     message and a remediation hint, and none of them leaks the raw host
 *     diagnostic into the message;
 *   - the two shapes a diagnostic can arrive in, and what a code that is *not*
 *     in the table does to the payload;
 *   - the resource footprint and return-value decoders when the RPC response is
 *     degraded (un-buildable `transactionData`, a missing `result`, an ScVal
 *     whose declared arm is absent).
 *
 * Nothing here asserts a specific hint's wording: the wording is product copy.
 * What is asserted is that the mapping is total, that it is injective, and that
 * the raw diagnostic is quarantined in `details.reason`.
 */

const mocks = vi.hoisted(() => ({
  server: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
  },
  assembleTransaction: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// `assembleTransaction` is stubbed only so the success fixtures do not need a
// restore preamble; `Api.isSimulationError` runs for real.
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: { ...actual.rpc, assembleTransaction: mocks.assembleTransaction },
  };
});

vi.mock('../src/logger.js', () => ({ default: mocks.logger }));

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
const tokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2));
const senderKp = Keypair.random();

/** `StreamError` variants declared by the contract (errors.rs) — codes 1..14. */
const DECLARED_CODES = Array.from({ length: 14 }, (_, i) => i + 1);

function hostDiagnostic(code: number | string): string {
  return `HostError: Error(Contract, #${code})`;
}

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

function simulationError(error: unknown): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: 'sim-1',
    latestLedger: 482_910,
    events: [],
    _parsed: true,
    error,
  } as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

/** Reject with a failed simulation of `error`, then hand back the ApiError. */
async function simulateFailure(error: unknown): Promise<InstanceType<typeof ApiError>> {
  mocks.server.simulateTransaction.mockResolvedValue(simulationError(error));
  try {
    await service.simulateStreamAction('cancel', senderKp.publicKey(), { streamId: '7' });
  } catch (err) {
    return err as InstanceType<typeof ApiError>;
  }
  throw new Error('expected the simulation error to reject');
}

type SimulationErrorDetails = {
  action?: string;
  reason?: string;
  hint?: string;
  contractErrorCode?: number;
};

/**
 * `details` is `unknown` on the shared ApiError; this suite knows the
 * simulation funnel always attaches the fields below, so narrow once here
 * instead of casting at every assertion.
 */
function detailsOf(err: { details?: unknown }): SimulationErrorDetails {
  return (err.details ?? {}) as SimulationErrorDetails;
}

let service: typeof import('../src/services/sorobanService.js');
let ApiError: typeof import('../src/lib/api-error.js').ApiError;

beforeAll(async () => {
  process.env.STREAM_CONTRACT_ID = contractId;
  process.env.STREAM_TOKEN_ADDRESS = tokenAddress;
  process.env.SOROBAN_RPC_URL = 'https://rpc.test';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.SOROBAN_RPC_MAX_RETRIES = '0';

  service = await import('../src/services/sorobanService.js');
  ({ ApiError } = await import('../src/lib/api-error.js'));
  service.setServer(mocks.server as unknown as rpc.Server);
});

afterAll(() => {
  delete process.env.STREAM_CONTRACT_ID;
  delete process.env.STREAM_TOKEN_ADDRESS;
  delete process.env.SOROBAN_RPC_URL;
  delete process.env.STELLAR_NETWORK;
  delete process.env.SOROBAN_RPC_MAX_RETRIES;
  delete process.env.SIMULATION_VALIDITY_LEDGERS;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.server.getAccount.mockResolvedValue(new Account(senderKp.publicKey(), '42'));
  mocks.server.simulateTransaction.mockResolvedValue(simulationSuccess());
  mocks.assembleTransaction.mockImplementation((tx: unknown) => ({ build: () => tx }));
  delete process.env.SIMULATION_VALIDITY_LEDGERS;
});

describe('toSimulationApiError — the StreamError table', () => {
  it('maps every declared contract code to a message and a hint', () => {
    for (const code of DECLARED_CODES) {
      const err = service.toSimulationApiError(hostDiagnostic(code), 'create');

      expect(err.statusCode, `code ${code}`).toBe(400);
      expect(err.code).toBe('simulation_failed');
      expect(detailsOf(err).contractErrorCode, `code ${code}`).toBe(code);
      expect(detailsOf(err).action).toBe('create');
      expect(detailsOf(err).reason).toBe(hostDiagnostic(code));
      expect(String(detailsOf(err).hint)).not.toBe('');
    }
  });

  it('keeps the host diagnostic out of every mapped message', () => {
    for (const code of DECLARED_CODES) {
      const err = service.toSimulationApiError(hostDiagnostic(code), 'withdraw');
      expect(err.message).not.toMatch(/HostError|Error\(Contract|#/);
      expect(err.message).not.toMatch(/^Simulation of/);
      expect(err.message).toBe(err.message.trim());
    }
  });

  it('gives each code its own message and its own hint', () => {
    const messages = DECLARED_CODES.map(
      (code) => service.toSimulationApiError(hostDiagnostic(code), 'create').message,
    );
    const hints = DECLARED_CODES.map(
      (code) => detailsOf(service.toSimulationApiError(hostDiagnostic(code), 'create')).hint,
    );

    // Two codes sharing a message means one of them was pasted in, so the
    // client shows the wrong explanation for a real failure.
    expect(new Set(messages).size).toBe(DECLARED_CODES.length);
    expect(new Set(hints).size).toBe(DECLARED_CODES.length);
    for (const code of DECLARED_CODES) {
      const err = service.toSimulationApiError(hostDiagnostic(code), 'create');
      expect(err.message).not.toBe(detailsOf(err).hint);
    }
  });

  it('carries the action through so the client can attribute the failure', () => {
    for (const action of ['create', 'withdraw', 'cancel', 'top_up', 'batch_withdraw'] as const) {
      const err = service.toSimulationApiError(hostDiagnostic(2), action);
      expect(detailsOf(err).action).toBe(action);
    }
  });
});

describe('toSimulationApiError — codes outside the table', () => {
  it('reports a parsed but unmapped code without inventing a hint', () => {
    for (const code of [15, 42, 999]) {
      const err = service.toSimulationApiError(hostDiagnostic(code), 'top_up');

      expect(detailsOf(err).contractErrorCode).toBe(code);
      expect('hint' in (detailsOf(err))).toBe(false);
      // The raw diagnostic is the only signal the client has for an unknown
      // variant, so it must survive into the message.
      expect(err.message).toContain(hostDiagnostic(code));
      expect(err.message).toContain('top_up');
    }
  });

  it('treats code 0 as a code rather than as a missing one', () => {
    const err = service.toSimulationApiError(hostDiagnostic(0), 'cancel');

    expect(detailsOf(err).contractErrorCode).toBe(0);
    expect('hint' in (detailsOf(err))).toBe(false);
  });

  it('omits contractErrorCode entirely for a diagnostic with no code', () => {
    const raw = 'transaction failed (result not ok)';
    const err = service.toSimulationApiError(raw, 'batch_withdraw');

    expect(Object.keys(detailsOf(err)).sort()).toEqual(['action', 'reason']);
    expect(detailsOf(err).reason).toBe(raw);
    expect(err.message).toBe(`Simulation of "batch_withdraw" failed: ${raw}`);
  });

  it('always keeps the verbatim diagnostic in details.reason', () => {
    const raws = [
      hostDiagnostic(3),
      hostDiagnostic(15),
      'restore precommand required',
      'tx Bad Sequencce',
    ];
    for (const raw of raws) {
      expect(detailsOf(service.toSimulationApiError(raw, 'create')).reason).toBe(raw);
    }
  });
});

describe('parseContractErrorCode', () => {
  it('reads the primary host-error form in its spelling variants', () => {
    expect(service.parseContractErrorCode(hostDiagnostic(7))).toBe(7);
    expect(service.parseContractErrorCode('Error(Contract,#8)')).toBe(8);
    expect(service.parseContractErrorCode('error(contract,  #9)')).toBe(9);
    expect(service.parseContractErrorCode(`xdr: ${hostDiagnostic(10)} trailing`)).toBe(10);
  });

  it('prefers the host-error form over a second number in the same line', () => {
    // Soroban prints both the trap and a human sentence; the parenthesised
    // code is authoritative, and the trailing amount is not an error code.
    const raw = `contract trapped: ${hostDiagnostic(4)} (amount 500 too small)`;
    expect(service.parseContractErrorCode(raw)).toBe(4);
  });

  it('falls back to the legacy "contract trapped" wording', () => {
    expect(service.parseContractErrorCode('Host function contract trapped, error: 11')).toBe(11);
    expect(service.parseContractErrorCode('Contract trapped #12')).toBe(12);
  });

  it('only reaches a short distance past "contract trapped"', () => {
    const near = `contract trapped${'a'.repeat(30)}5`;
    const far = `contract trapped${'a'.repeat(60)}5`;

    expect(service.parseContractErrorCode(near)).toBe(5);
    expect(service.parseContractErrorCode(far)).toBeNull();
  });

  it('bounds the trapped fallback to four digits', () => {
    // The primary form is unbounded; only the legacy wording truncates.
    expect(service.parseContractErrorCode(hostDiagnostic(12345))).toBe(12345);
    expect(service.parseContractErrorCode('contract trapped #12345')).toBe(1234);
  });

  it('does not mistake an amount or a ledger for an error code', () => {
    const noCodes = [
      '',
      'tx_bad_auth',
      'params.amount must be greater than zero',
      'insufficient balance 1000000 stroops',
      'Error(Contract, #)',
      'Error(Contract, #abc)',
      'not a stellar error at all 2026-11-21',
    ];
    for (const raw of noCodes) {
      expect(service.parseContractErrorCode(raw), raw).toBeNull();
    }
  });
});

describe('simulateStreamAction — failed simulation payloads', () => {
  it('turns a string simulation error into the mapped 400', async () => {
    const err = await simulateFailure(hostDiagnostic(2));

    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Stream not found');
    expect(detailsOf(err).contractErrorCode).toBe(2);
  });

  it('serialises a structured simulation error instead of printing [object Object]', async () => {
    const diagnostic = { error_code: 3, detail: 'caller is not recipient' };
    const err = await simulateFailure(diagnostic);

    expect(detailsOf(err).reason).toBe(JSON.stringify(diagnostic));
    expect(err.message).toContain(JSON.stringify(diagnostic));
    expect(err.message).not.toContain('[object Object]');
  });

  it('keeps a non-object, non-string error renderable', async () => {
    const err = await simulateFailure('Error(Contract, #13)');
    expect(detailsOf(err).contractErrorCode).toBe(13);

    const arrayErr = await simulateFailure([hostDiagnostic(1)]);
    expect(detailsOf(arrayErr).reason).toBe(JSON.stringify([hostDiagnostic(1)]));
  });
});

describe('simulateStreamAction — degraded success responses', () => {
  it('reports a zero footprint when transactionData cannot be built', async () => {
    mocks.server.simulateTransaction.mockResolvedValue(
      simulationSuccess({
        transactionData: {
          build: () => {
            throw new Error('malformed soroban transaction data');
          },
        } as unknown as SorobanDataBuilder,
      }),
    );

    const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
      streamId: '7',
    });

    expect(result.cpuInstructions).toBe(0);
    expect(result.memoryBytes).toBe(0);
    // The request still succeeds — the fee is what the wallet needs most.
    expect(result.recommendedFee).toBe('1150');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[SorobanService] Could not read resource footprint from simulation:',
      expect.any(Error),
    );
  });

  it('excludes readBytes from the reported memory footprint', async () => {
    mocks.server.simulateTransaction.mockResolvedValue(
      simulationSuccess({
        transactionData: new SorobanDataBuilder().setResources(1, 1_000_000, 5),
      }),
    );

    const result = await service.simulateStreamAction('cancel', senderKp.publicKey(), {
      streamId: '7',
    });

    expect(result.cpuInstructions).toBe(1);
    expect(result.memoryBytes).toBe(5);
  });

  const retvalCases: Array<{ label: string; expected: string; retval: () => xdr.ScVal }> = [
    {
      label: 'u64 at its maximum',
      expected: '18446744073709551615',
      retval: () => nativeToScVal(BigInt('18446744073709551615'), { type: 'u64' }),
    },
    {
      label: 'u32 at its maximum',
      expected: '4294967295',
      retval: () => nativeToScVal(4_294_967_295, { type: 'u32' }),
    },
    {
      label: 'i64 at its minimum',
      expected: '-9223372036854775808',
      retval: () => nativeToScVal(BigInt('-9223372036854775808'), { type: 'i64' }),
    },
    {
      label: 'u128 at its maximum',
      expected: '340282366920938463463374607431768211455',
      retval: () => nativeToScVal(BigInt('340282366920938463463374607431768211455'), { type: 'u128' }),
    },
    {
      label: 'i128 at its minimum',
      expected: '-170141183460469231731687303715884105728',
      retval: () => nativeToScVal(BigInt('-170141183460469231731687303715884105728'), { type: 'i128' }),
    },
  ];

  for (const testCase of retvalCases) {
    it(`decodes a ${testCase.label} return as a decimal string`, async () => {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess({ result: { auth: [], retval: testCase.retval() } }),
      );

      const result = await service.simulateStreamAction('withdraw', senderKp.publicKey(), {
        streamId: '1',
      });

      expect(result.simulatedReturn).toBe(testCase.expected);
    });
  }

  it('renders an unsigned i128 whose high arm is negative', async () => {
    mocks.server.simulateTransaction.mockResolvedValue(
      simulationSuccess({
        result: { auth: [], retval: nativeToScVal(BigInt('-1'), { type: 'i128' }) },
      }),
    );

    const result = await service.simulateStreamAction('withdraw', senderKp.publicKey(), {
      streamId: '1',
    });

    expect(result.simulatedReturn).toBe('-1');
  });

  it('returns an empty string when the declared ScVal arm is missing', async () => {
    const broken = [
      { type: 'scvI128' },
      { type: 'scvU64' },
      { type: 'scvU128', value: { hi: 1 } },
      { type: 'scvSomethingElse' },
    ];

    for (const retval of broken) {
      mocks.server.simulateTransaction.mockResolvedValue(
        simulationSuccess({ result: { auth: [], retval: retval as unknown as xdr.ScVal } }),
      );

      const result = await service.simulateStreamAction('withdraw', senderKp.publicKey(), {
        streamId: '1',
      });

      expect(result.simulatedReturn, JSON.stringify(retval)).toBe('');
    }
  });

  it('returns an empty string when the retval itself is absent', async () => {
    mocks.server.simulateTransaction.mockResolvedValue(
      simulationSuccess({ result: { auth: [] } as never }),
    );

    const result = await service.simulateStreamAction('withdraw', senderKp.publicKey(), {
      streamId: '1',
    });

    expect(result.simulatedReturn).toBe('');
  });
});

describe('SIMULATION_VALIDITY_LEDGERS', () => {
  it('widens the freshness window from the environment', async () => {
    process.env.SIMULATION_VALIDITY_LEDGERS = '25';
    vi.resetModules();
    const fresh = await import('../src/services/sorobanService.js');
    fresh.setServer(mocks.server as unknown as rpc.Server);

    const result = await fresh.simulateStreamAction('cancel', senderKp.publicKey(), {
      streamId: '7',
    });

    expect(result.expiresAtLedger).toBe(482_910 + 25);
  });
});
