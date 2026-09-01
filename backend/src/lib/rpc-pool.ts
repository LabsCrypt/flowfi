import { rpc } from '@stellar/stellar-sdk';
import logger from '../logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface RpcEndpointHealth {
  url: string;
  failures: number;
  latencyMs: number | null;
  state: CircuitState;
  openedAt: number | null;
}

export interface RpcPoolOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  probeIntervalMs?: number;
  timeoutMs?: number;
  createServer?: (url: string) => rpc.Server;
}

const DEFAULT_URL = 'https://soroban-testnet.stellar.org';

export function getRpcUrls(value = process.env.SOROBAN_RPC_URLS ?? process.env.SOROBAN_RPC_URL): string[] {
  return (value ?? DEFAULT_URL).split(',').map((url) => url.trim()).filter(Boolean);
}

export class RpcPool {
  private readonly endpoints: Array<RpcEndpointHealth & { server: rpc.Server }>;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly createServer: (url: string) => rpc.Server;
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(urls = getRpcUrls(), options: RpcPoolOptions = {}) {
    const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    if (uniqueUrls.length === 0) throw new Error('At least one Soroban RPC URL is required');
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SOROBAN_RPC_TIMEOUT_MS ?? 10_000);
    this.createServer = options.createServer ?? ((url) => new rpc.Server(url, { allowHttp: true }));
    this.endpoints = uniqueUrls.map((url) => ({
      url,
      server: this.createServer(url),
      failures: 0,
      latencyMs: null,
      state: 'CLOSED',
      openedAt: null,
    }));
  }

  startHealthProbes(intervalMs = 30_000): void {
    this.stopHealthProbes();
    void this.probeAll();
    this.probeTimer = setInterval(() => void this.probeAll(), intervalMs);
  }

  stopHealthProbes(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  getHealth(): RpcEndpointHealth[] {
    return this.endpoints.map(({ server: _server, ...health }) => ({ ...health }));
  }

  async execute<T>(label: string, operation: (server: rpc.Server, signal: AbortSignal) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const endpoint of this.availableEndpoints()) {
      const controller = new AbortController();
      const started = Date.now();
      try {
        const result = await Promise.race([
          operation(endpoint.server, controller.signal),
          new Promise<never>((_, reject) => setTimeout(() => {
            controller.abort();
            reject(new Error(`${label} timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs)),
        ]);
        this.recordSuccess(endpoint, Date.now() - started);
        return result;
      } catch (error) {
        lastError = error;
        this.recordFailure(endpoint, error, Date.now() - started);
        logger.warn(`[RpcPool] ${label} failed on ${endpoint.url}; failing over`, { error });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} failed on all RPC endpoints`);
  }

  private availableEndpoints() {
    const now = Date.now();
    return this.endpoints.filter((endpoint) => {
      if (endpoint.state !== 'OPEN') return true;
      if (endpoint.openedAt !== null && now - endpoint.openedAt >= this.cooldownMs) {
        endpoint.state = 'HALF_OPEN';
        logger.info(`[RpcPool] Circuit half-open for ${endpoint.url}`);
        return true;
      }
      return false;
    }).sort((a, b) => (a.failures - b.failures) || ((a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)));
  }

  private recordSuccess(endpoint: RpcEndpointHealth & { server: rpc.Server }, latencyMs: number): void {
    endpoint.failures = 0;
    endpoint.latencyMs = latencyMs;
    endpoint.state = 'CLOSED';
    endpoint.openedAt = null;
  }

  private recordFailure(endpoint: RpcEndpointHealth & { server: rpc.Server }, error: unknown, latencyMs: number): void {
    endpoint.failures += 1;
    endpoint.latencyMs = latencyMs;
    if (endpoint.failures >= this.failureThreshold) {
      endpoint.state = 'OPEN';
      endpoint.openedAt = Date.now();
      logger.error(`[RpcPool] Circuit opened for ${endpoint.url}`, { error });
    }
  }

  async probe(): Promise<void> {
    await this.probeAll();
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        const started = Date.now();
        await Promise.race([
          Promise.all([endpoint.server.getHealth(), endpoint.server.getLatestLedger()]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('health probe timeout')), this.timeoutMs)),
        ]);
        this.recordSuccess(endpoint, Date.now() - started);
      } catch (error) {
        this.recordFailure(endpoint, error, this.timeoutMs);
      }
    }));
  }
}

export const rpcPool = new RpcPool();
rpcPool.startHealthProbes();
