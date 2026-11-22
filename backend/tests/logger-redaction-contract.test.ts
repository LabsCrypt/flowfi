/**
 * Logger contract and secret-redaction coverage (issue #1768).
 *
 * `src/logger.ts` is 21 lines that every other module funnels through, and
 * nothing tested it: the record shape, the request-id injection, the level
 * gate and the metadata edge cases were all only implied by reading winston's
 * docs. Several of them are security-relevant — a logger that throws on
 * circular metadata inside an error handler silently eats the error, and a
 * `LOG_LEVEL` typo silently stops logging altogether.
 *
 * Issue #1768 asks for redaction regression tests. There is no redaction in
 * this logger (or anywhere in `backend/src`: the only sanitizer,
 * `sanitizeDatabaseErrorMessage`, rewrites HTTP error bodies, not log lines),
 * so the last describe block pins what happens TODAY: authorization headers,
 * API keys, signing-key buffers and secrets embedded in `Error` messages all
 * reach the wire verbatim. Those tests are the spec an implementation should
 * flip, which is why each one also asserts the record stays parseable, and
 * why they are labelled as the gap rather than as desired behaviour.
 *
 * Output is captured by replacing `console._stdout.write`, which is the exact
 * property winston's Console transport reads at log time
 * (`node_modules/winston/lib/winston/transports/console.js:85-91`). Spying
 * `console.log` or `process.stdout.write` does not work: the transport
 * bypasses both, and vitest intercepts the latter.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as os from 'node:os';

type LogRecord = Record<string, any>;
type WriteStream = { write: (chunk: string) => boolean };
type LoggerModule = typeof import('../src/logger.js');

const consoleStreams = console as unknown as { _stdout: WriteStream; _stderr: WriteStream };

/** Collects the bytes winston actually writes; one entry per log record. */
function captureStdout() {
  const chunks: string[] = [];
  const real = consoleStreams._stdout.write;
  consoleStreams._stdout.write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    chunks,
    /** The `chunk` with its trailing EOL removed, i.e. the physical log line. */
    line(index: number): string {
      const chunk = chunks[index]!;
      expect(chunk.endsWith(os.EOL)).toBe(true);
      return chunk.slice(0, -os.EOL.length);
    },
    record(index: number): LogRecord {
      return JSON.parse(this.line(index)) as LogRecord;
    },
    lines(): string[] {
      return chunks.map((_chunk, index) => this.line(index));
    },
    records(): LogRecord[] {
      return chunks.map((_chunk, index) => this.record(index));
    },
    restore(): void {
      consoleStreams._stdout.write = real;
    },
  };
}

let logger: LoggerModule['default'];
let requestContext: LoggerModule['requestContext'];

/** Fresh module instance, optionally under a specific `LOG_LEVEL`. */
async function loadLogger(logLevel?: string): Promise<LoggerModule> {
  const previous = process.env.LOG_LEVEL;
  vi.resetModules();
  if (logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = logLevel;
  try {
    return await import('../src/logger.js');
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
}

beforeAll(async () => {
  const mod = await loadLogger();
  logger = mod.default;
  requestContext = mod.requestContext;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capture seam', () => {
  it('reads the same stream winston writes to', () => {
    // Every assertion below depends on this being the transport's real target;
    // a silent fallback to `console.log` would capture nothing and pass
    // vacuously.
    expect(typeof consoleStreams._stdout.write).toBe('function');

    const sink = captureStdout();
    try {
      logger.info('probe');
    } finally {
      sink.restore();
    }
    expect(sink.chunks).toHaveLength(1);
  });
});

describe('record shape', () => {
  it('emits one JSON record with exactly level, message and timestamp', () => {
    const sink = captureStdout();
    try {
      logger.info('stream created');
    } finally {
      sink.restore();
    }

    expect(sink.chunks).toHaveLength(1);
    expect(sink.record(0)).toEqual({
      level: 'info',
      message: 'stream created',
      timestamp: expect.any(String),
    });
    expect(Object.keys(sink.record(0)).sort()).toEqual(['level', 'message', 'timestamp']);
  });

  it('timestamps with a losslessly round-trippable ISO-8601 instant', () => {
    const sink = captureStdout();
    try {
      logger.info('when');
    } finally {
      sink.restore();
    }

    const timestamp = sink.record(0).timestamp as string;
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('escapes an embedded newline so a message cannot forge a second record', () => {
    // A forged line is how log injection makes an audit trail lie: the attacker
    // wants a record that was never written to look like it was.
    const sink = captureStdout();
    try {
      logger.info('withdrawn\n{"level":"info","message":"withdrawn by attacker"}');
    } finally {
      sink.restore();
    }

    expect(sink.chunks).toHaveLength(1);
    expect(sink.line(0)).not.toContain('\n');
    expect(sink.record(0).message).toContain('{"level":"info"');
  });

  it('still emits a record for an empty message', () => {
    const sink = captureStdout();
    try {
      logger.info('');
    } finally {
      sink.restore();
    }

    expect(sink.record(0)).toMatchObject({ level: 'info', message: '' });
  });

  it('does not let metadata overwrite the record level', () => {
    const sink = captureStdout();
    try {
      logger.warn('spoof', { level: 'FAKE' });
    } finally {
      sink.restore();
    }

    expect(sink.record(0).level).toBe('warn');
  });

  it('folds metadata message into the log message instead of shadowing it', () => {
    const sink = captureStdout();
    try {
      logger.info('stream', { message: '123 paused' });
    } finally {
      sink.restore();
    }

    const record = sink.record(0);
    expect(record.message).toBe('stream 123 paused');
    expect(Object.keys(record).sort()).toEqual(['level', 'message', 'timestamp']);
  });

  it('appends an Error message and its stack rather than dropping the error', () => {
    const sink = captureStdout();
    try {
      logger.error('simulation failed', new Error('host returned 500'));
    } finally {
      sink.restore();
    }

    const record = sink.record(0);
    expect(record.level).toBe('error');
    expect(record.message).toBe('simulation failed host returned 500');
    expect(record.stack).toContain('Error: host returned 500');
  });

  it('keeps an object passed as the message intact', () => {
    const sink = captureStdout();
    try {
      logger.info({ streamId: 7 } as any);
    } finally {
      sink.restore();
    }

    // Boundary input: callers do hit this, and the record must stay valid JSON
    // and stay on one line rather than dumping a multi-line object.
    expect(sink.record(0).message).toEqual({ streamId: 7 });
  });
});

describe('request correlation', () => {
  it('omits requestId outside a request context', () => {
    const sink = captureStdout();
    try {
      logger.info('boot');
    } finally {
      sink.restore();
    }

    expect(sink.record(0)).not.toHaveProperty('requestId');
  });

  it('injects requestId from the surrounding request context', () => {
    const sink = captureStdout();
    try {
      requestContext.run({ requestId: 'req-abc' }, () => logger.info('claimed'));
    } finally {
      sink.restore();
    }

    expect(sink.record(0)).toMatchObject({ message: 'claimed', requestId: 'req-abc' });
  });

  it('keeps the innermost requestId when contexts nest', () => {
    const sink = captureStdout();
    try {
      requestContext.run({ requestId: 'outer' }, () =>
        requestContext.run({ requestId: 'inner' }, () => logger.info('nested')),
      );
    } finally {
      sink.restore();
    }

    expect(sink.record(0).requestId).toBe('inner');
  });

  it('does not cross request ids between concurrent requests', async () => {
    const sink = captureStdout();
    try {
      await Promise.all(
        ['req-1', 'req-2', 'req-3'].map((requestId) =>
          requestContext.run({ requestId }, async () => {
            await Promise.resolve();
            logger.info('handled');
          }),
        ),
      );
    } finally {
      sink.restore();
    }

    expect(sink.records().map((record) => record.requestId)).toEqual(['req-1', 'req-2', 'req-3']);
  });

  it('restores the context-free state once the scope exits', () => {
    const sink = captureStdout();
    try {
      requestContext.run({ requestId: 'transient' }, () => logger.info('inside'));
      logger.info('after');
    } finally {
      sink.restore();
    }

    expect(sink.records().map((record) => record.requestId)).toEqual(['transient', undefined]);
  });
});

describe('level gating', () => {
  it('drops everything below the default info level', () => {
    const sink = captureStdout();
    try {
      logger.silly('silly');
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    } finally {
      sink.restore();
    }

    expect(sink.records().map((record) => record.level)).toEqual(['info', 'warn', 'error']);
  });

  it('gates on LOG_LEVEL when the module is loaded', async () => {
    const cases: Array<{ level: string; expected: string[] }> = [
      { level: 'error', expected: ['error'] },
      { level: 'warn', expected: ['warn', 'error'] },
      { level: 'debug', expected: ['debug', 'info', 'warn', 'error'] },
      { level: 'silly', expected: ['silly', 'debug', 'info', 'warn', 'error'] },
    ];

    for (const { level, expected } of cases) {
      const { default: scoped } = await loadLogger(level);
      const sink = captureStdout();
      try {
        scoped.silly('silly');
        scoped.debug('debug');
        scoped.info('info');
        scoped.warn('warn');
        scoped.error('error');
      } finally {
        sink.restore();
      }
      expect(sink.records().map((record) => record.level), `LOG_LEVEL=${level}`).toEqual(expected);
    }
  });

  it('falls back to info for an empty LOG_LEVEL', async () => {
    // `process.env.LOG_LEVEL || 'info'` treats "" as unset, which is what an
    // `ENV LOG_LEVEL=` in a Dockerfile produces.
    const { default: scoped } = await loadLogger('');
    const sink = captureStdout();
    try {
      scoped.debug('debug');
      scoped.info('info');
    } finally {
      sink.restore();
    }

    expect(sink.records().map((record) => record.level)).toEqual(['info']);
  });

  it('silences every record when LOG_LEVEL is not a known level name', async () => {
    // Pinned as a finding: a typo like `LOG_LEVEL=INFO` or `verbose` is not
    // rejected and does not fall back to the default — it drops all logs.
    const { default: scoped } = await loadLogger('NOT_A_LEVEL');
    const sink = captureStdout();
    try {
      scoped.error('error');
      scoped.warn('warn');
    } finally {
      sink.restore();
    }

    expect(sink.chunks).toEqual([]);
  });
});

describe('metadata robustness', () => {
  it('renders circular metadata instead of throwing', () => {
    const circular: LogRecord = { name: 'loop' };
    circular.self = circular;

    const sink = captureStdout();
    try {
      expect(() => logger.info('cycle', { thing: circular })).not.toThrow();
    } finally {
      sink.restore();
    }

    expect(sink.record(0).thing).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('drops function metadata', () => {
    const sink = captureStdout();
    try {
      logger.info('with cb', { cb: () => 1 });
    } finally {
      sink.restore();
    }

    expect(sink.record(0)).not.toHaveProperty('cb');
  });

  it('serializes BigInt amounts', () => {
    const sink = captureStdout();
    try {
      logger.info('amount', { ratePerSecond: 10n });
    } finally {
      sink.restore();
    }

    // i128 values reach the logger as BigInt from the Soroban layer; a throwing
    // JSON.stringify there would take down the request.
    expect(sink.record(0).ratePerSecond).toBe('10');
  });

  it('tolerates undefined and null metadata', () => {
    const sink = captureStdout();
    try {
      logger.info('undef', undefined);
      logger.info('nul', null as any);
    } finally {
      sink.restore();
    }

    expect(sink.records().map((record) => record.message)).toEqual(['undef', 'nul']);
  });
});

describe('secret handling (the gap #1768 describes)', () => {
  it('never serializes the process environment into a record', () => {
    // This one holds before and after redaction exists: the logger must not leak
    // configuration it was never handed.
    process.env.LOGGER_TEST_ENV_PROBE = 'env-should-never-appear';
    const sink = captureStdout();
    try {
      logger.info('configured');
      logger.error('failed', new Error('startup problem'));
    } finally {
      sink.restore();
      delete process.env.LOGGER_TEST_ENV_PROBE;
    }

    expect(sink.lines().join('')).not.toContain('env-should-never-appear');
  });

  it('writes an authorization header verbatim', () => {
    const sink = captureStdout();
    try {
      logger.warn('request', { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.live' } });
    } finally {
      sink.restore();
    }

    const line = sink.line(0);
    // No redaction is applied anywhere today: neither marker appears.
    expect(line).toContain('Bearer eyJhbGciOiJIUzI1NiJ9.live');
    expect(line).not.toMatch(/\[REDACTED\]|\*\*\*/i);
    expect(JSON.parse(line)).toMatchObject({ level: 'warn' });
  });

  it('hoists a nested API key to a top-level field and keeps it verbatim', () => {
    const sink = captureStdout();
    try {
      logger.info('webhook created', { target: { apiKey: 'whsec_live_123' } });
    } finally {
      sink.restore();
    }

    const record = sink.record(0);
    // Metadata is spread flat into the record, so a redaction implementation has
    // to walk nested objects as well as top-level keys.
    expect(record.target).toEqual({ apiKey: 'whsec_live_123' });
    expect(record.authorization).toBeUndefined();
  });

  it('writes signing-key bytes out as a readable Buffer array', () => {
    const seed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const sink = captureStdout();
    try {
      logger.info('keypair derived', { seed });
    } finally {
      sink.restore();
    }

    const record = sink.record(0);
    expect(record.seed).toEqual({ type: 'Buffer', data: [...seed] });
  });

  it('carries a secret embedded in an Error message into both message and stack', () => {
    const sink = captureStdout();
    try {
      logger.error('signing failed', new Error('missing seed sp01 secret'));
    } finally {
      sink.restore();
    }

    const record = sink.record(0);
    // Error metadata is the worst case for a key-name-based scrubber: the secret
    // is free text, duplicated across `message` and `stack`.
    expect(record.message).toBe('signing failed missing seed sp01 secret');
    expect(record.stack).toContain('missing seed sp01 secret');
  });
});
