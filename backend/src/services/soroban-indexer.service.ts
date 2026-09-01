import logger from '../logger.js';
import { withRpcRetry, withRpcTimeout } from './sorobanService.js';
import { prisma } from '../lib/prisma.js';

interface RpcEvent { id?: string; ledger?: number; ledgerSequence?: number; txHash?: string; topic?: unknown[]; value?: unknown; contractId?: string; }
interface RpcResponse { result?: { events?: RpcEvent[] }; error?: { message?: string }; }

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const POLL_MS = Number(process.env.SOROBAN_INDEXER_POLL_MS ?? 15000);
const START_LEDGER = Number(process.env.SOROBAN_INDEXER_START_LEDGER ?? 0);
const CONTRACT_ID = process.env.STREAM_CONTRACT_ID ?? '';

/** @deprecated Production indexing is owned by SorobanEventWorker. Kept for API/test compatibility. */
export class SorobanIndexerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastLedger = START_LEDGER;

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async poll(): Promise<void> {
    if (!CONTRACT_ID) return;
    try {
      const response = await withRpcRetry('getEvents', () => withRpcTimeout('getEvents', (signal) =>
        fetch(RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEvents', params: {
            startLedger: this.lastLedger + 1,
            filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
            pagination: { limit: 100 },
          } }),
          signal,
        }),
      ));
      if (!response.ok) throw new Error(`getEvents failed: ${response.status}`);
      const payload = (await response.json()) as RpcResponse;
      if (payload.error?.message) throw new Error(payload.error.message);
      for (const event of payload.result?.events ?? []) {
        this.lastLedger = Math.max(this.lastLedger, Number(event.ledgerSequence ?? event.ledger ?? 0));
      }
    } catch (error) {
      logger.error('Soroban indexer poll failed', error);
    }
  }
}

export const sorobanIndexerService = new SorobanIndexerService();
void prisma;
