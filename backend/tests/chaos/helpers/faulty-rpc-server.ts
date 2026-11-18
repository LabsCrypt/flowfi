/**
 * Deterministic, in-process JSON-RPC fault injector for the chaos suite
 * (issue #1477).
 *
 * Toxiproxy covers transport-level faults (latency, packet loss, resets) but
 * cannot synthesise application-level behaviour such as "return HTTP 429 under
 * burst traffic" or "return a malformed response". This stub fills that gap so
 * the failover / dead-letter assertions remain hermetic and flake-free — they
 * need neither Docker nor network access.
 */
import http from 'http';
import type { AddressInfo } from 'net';

export type FaultyRpcMode =
  | 'healthy'
  | 'rate-limit'
  | 'hang'
  | 'malformed'
  | 'reset';

export interface StartFaultyRpcOptions {
  /** Behaviour to start in. Defaults to `healthy`. */
  mode?: FaultyRpcMode;
  /** HTTP status used by `rate-limit`. Defaults to 429. */
  rateLimitStatus?: number;
}

export interface FaultyRpcServer {
  /** `http://127.0.0.1:<port>` suitable for `new rpc.Server(url, { allowHttp: true })`. */
  readonly url: string;
  readonly port: number;
  /** Number of JSON-RPC calls received so far. */
  requestCount(): number;
  /** Switch fault mode at runtime (mid-scenario). */
  setMode(mode: FaultyRpcMode): void;
  mode(): FaultyRpcMode;
  close(): Promise<void>;
}

function healthyResult(method: string): Record<string, unknown> {
  if (method === 'getHealth') return { status: 'healthy' };
  // `getLatestLedger` needs real XDR to parse, so we let callers that care
  // assert against `getHealth` and return an opaque result here.
  return {};
}

/**
 * Start a JSON-RPC endpoint whose failure mode can be flipped at any time.
 * The underlying socket/port are released by `close()`.
 */
export async function startFaultyRpcServer(
  options: StartFaultyRpcOptions = {},
): Promise<FaultyRpcServer> {
  let currentMode: FaultyRpcMode = options.mode ?? 'healthy';
  const rateLimitStatus = options.rateLimitStatus ?? 429;
  let requests = 0;

  const server = http.createServer((req, res) => {
    requests += 1;

    // Drain the body so the client's write finishes before we respond.
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      switch (currentMode) {
        case 'reset':
          req.socket.destroy();
          return;
        case 'hang':
          // Never respond; the caller relies on its own timeout to abort.
          return;
        case 'rate-limit':
          res.writeHead(rateLimitStatus, {
            'content-type': 'application/json',
            'retry-after': '1',
          });
          res.end(JSON.stringify({ error: 'Too Many Requests' }));
          return;
        case 'malformed':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{ this is not valid json ');
          return;
        case 'healthy':
        default: {
          let id: unknown = null;
          let method = '';
          try {
            const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
            id = parsed.id ?? null;
            method = parsed.method ?? '';
          } catch {
            // fall through with empty method
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', id, result: healthyResult(method) }),
          );
          return;
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requestCount: () => requests,
    setMode: (mode: FaultyRpcMode) => {
      currentMode = mode;
    },
    mode: () => currentMode,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Convenience: start one healthy and one faulty endpoint for failover tests. */
export async function startFailoverPair(primaryMode: FaultyRpcMode = 'rate-limit'): Promise<{
  primary: FaultyRpcServer;
  secondary: FaultyRpcServer;
  close: () => Promise<void>;
}> {
  const primary = await startFaultyRpcServer({ mode: primaryMode });
  const secondary = await startFaultyRpcServer({ mode: 'healthy' });
  return {
    primary,
    secondary,
    close: async () => {
      await Promise.all([primary.close(), secondary.close()]);
    },
  };
}
