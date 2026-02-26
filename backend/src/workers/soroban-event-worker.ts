/**
 * Soroban Event Worker
 *
 * Polls the Stellar Soroban RPC for contract events emitted by the FlowFi
 * stream contract and syncs them to the PostgreSQL database.
 *
 * Handles:
 *   - StreamCreatedEvent   (topic: "stream_created")
 *   - StreamToppedUpEvent  (topic: "stream_topped_up")
 *   - TokensWithdrawnEvent (topic: "tokens_withdrawn")
 *   - StreamCancelledEvent (topic: "stream_cancelled")
 */

import { SorobanRpc, xdr, StrKey } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma.js';
import { sseService } from '../services/sse.service.js';
import logger from '../logger.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const INDEXER_STATE_ID = 'singleton';

// ─── XDR Decoding Helpers ────────────────────────────────────────────────────

/** Decode an ScVal symbol to a string. */
function decodeSymbol(val: xdr.ScVal): string {
  return val.sym().toString();
}

/**
 * Decode an ScVal U64 to a JavaScript bigint.
 * `xdr.UInt64` extends Long; `.toString()` gives the decimal representation.
 */
function decodeU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/**
 * Decode an ScVal I128 to a decimal string suitable for DB storage.
 * I128 in XDR is split into hi (signed Int64) and lo (unsigned Uint64).
 * Full value = hi * 2^64 + lo.
 */
function decodeI128(val: xdr.ScVal): string {
  const parts = val.i128();
  const hi = BigInt.asIntN(64, BigInt(parts.hi().toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  return ((hi << 64n) | lo).toString();
}

/**
 * Decode an ScVal Address to a Stellar public key (G...) or contract (C...)
 * string.
 */
function decodeAddress(val: xdr.ScVal): string {
  const addr = val.address();
  if (
    addr.switch().value ===
    xdr.ScAddressType.scAddressTypeAccount().value
  ) {
    return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
  }
  return StrKey.encodeContract(addr.contractId());
}

/**
 * Decode an ScVal Map (a `#[contracttype]` struct) into a plain object keyed
 * by field name with raw ScVal values for further decoding.
 */
function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  const entries = val.map();
  if (!entries) return result;
  for (const entry of entries) {
    result[entry.key().sym().toString()] = entry.val();
  }
  return result;
}

// ─── Worker Class ─────────────────────────────────────────────────────────────

export class SorobanEventWorker {
  private readonly server: SorobanRpc.Server;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number;

  private isRunning = false;
  private pollTimer?: NodeJS.Timeout;

  constructor() {
    const rpcUrl =
      process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
    this.contractId = process.env.STREAM_CONTRACT_ID ?? '';
    this.pollIntervalMs = parseInt(
      process.env.INDEXER_POLL_INTERVAL_MS ?? '5000',
      10,
    );
    this.startLedger = parseInt(
      process.env.INDEXER_START_LEDGER ?? '0',
      10,
    );
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
  }

  /**
   * Start the polling worker. If `STREAM_CONTRACT_ID` is not configured the
   * worker logs a warning and exits gracefully instead of throwing.
   */
  async start(): Promise<void> {
    if (!this.contractId) {
      logger.warn(
        '[SorobanWorker] STREAM_CONTRACT_ID is not set — event indexing disabled.',
      );
      return;
    }

    this.isRunning = true;
    logger.info('[SorobanWorker] Starting Soroban event indexer…');
    await this.poll();
  }

  /** Stop the worker gracefully. */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    logger.info('[SorobanWorker] Stopped.');
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.fetchAndProcessEvents();
    } catch (err) {
      logger.error('[SorobanWorker] Unhandled error during poll:', err);
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Fetch a batch of events from the Soroban RPC starting from the last known
   * cursor (or start ledger on first run) and process each one in order.
   */
  private async fetchAndProcessEvents(): Promise<void> {
    // Ensure an IndexerState row exists on first run.
    const state = await prisma.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: {
        id: INDEXER_STATE_ID,
        lastLedger: this.startLedger,
        lastCursor: null,
      },
      update: {},
    });

    const baseFilter = {
      filters: [
        {
          type: 'contract' as const,
          contractIds: [this.contractId],
        },
      ],
      limit: 100,
    } satisfies Omit<Parameters<SorobanRpc.Server['getEvents']>[0], 'startLedger' | 'cursor'>;

    // Prefer cursor-based pagination after the first poll so we never
    // re-process events.
    const params: Parameters<SorobanRpc.Server['getEvents']>[0] =
      state.lastCursor
        ? { ...baseFilter, cursor: state.lastCursor }
        : { ...baseFilter, startLedger: state.lastLedger || this.startLedger };

    const response = await this.server.getEvents(params);

    if (response.events.length === 0) return;

    let lastCursor: string | null = state.lastCursor;
    let lastLedger: number = state.lastLedger;

    for (const event of response.events) {
      // Only process events from successful contract calls.
      if (!event.inSuccessfulContractCall) continue;

      try {
        await this.processEvent(event);
        lastCursor = event.pagingToken;
        lastLedger = event.ledger;
      } catch (err) {
        logger.error(
          `[SorobanWorker] Failed to process event ${event.id}:`,
          err,
        );
        // Continue processing subsequent events rather than halting.
      }
    }

    await prisma.indexerState.update({
      where: { id: INDEXER_STATE_ID },
      data: { lastLedger, lastCursor },
    });

    logger.info(
      `[SorobanWorker] Processed ${response.events.length} event(s) — latest ledger: ${lastLedger}`,
    );
  }

  /**
   * Dispatch a single contract event to the appropriate handler based on the
   * first topic symbol.
   */
  private async processEvent(
    event: SorobanRpc.Api.EventResponse,
  ): Promise<void> {
    if (!event.topic || event.topic.length < 2) return;

    // Explicit variable assignment avoids `noUncheckedIndexedAccess` errors.
    const topic0: xdr.ScVal | undefined = event.topic[0];
    const topic1: xdr.ScVal | undefined = event.topic[1];
    if (!topic0 || !topic1) return;

    const eventName = decodeSymbol(topic0);

    switch (eventName) {
      case 'stream_created':
        await this.handleStreamCreated(event, topic1);
        break;
      case 'stream_topped_up':
        await this.handleStreamToppedUp(event, topic1);
        break;
      case 'tokens_withdrawn':
        await this.handleTokensWithdrawn(event, topic1);
        break;
      case 'stream_cancelled':
        await this.handleStreamCancelled(event, topic1);
        break;
      default:
        // Unrecognised event — ignore silently.
        break;
    }
  }

  // ─── Event Handlers ────────────────────────────────────────────────────────

  /**
   * StreamCreatedEvent
   * Topics : [Symbol("stream_created"), U64(stream_id)]
   * Body   : Map { stream_id, sender, recipient, rate_per_second,
   *                token_address, deposited_amount, start_time }
   */
  private async handleStreamCreated(
    event: SorobanRpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (
      !body['sender'] ||
      !body['recipient'] ||
      !body['token_address'] ||
      !body['rate_per_second'] ||
      !body['deposited_amount'] ||
      !body['start_time']
    ) {
      throw new Error(`StreamCreated #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body['sender']);
    const recipient = decodeAddress(body['recipient']);
    const tokenAddress = decodeAddress(body['token_address']);
    const ratePerSecond = decodeI128(body['rate_per_second']);
    const depositedAmount = decodeI128(body['deposited_amount']);
    const startTime = Number(decodeU64(body['start_time']));

    await prisma.$transaction(async (tx) => {
      // Ensure both wallet accounts exist in the Users table.
      await tx.user.upsert({
        where: { publicKey: sender },
        create: { publicKey: sender },
        update: {},
      });
      await tx.user.upsert({
        where: { publicKey: recipient },
        create: { publicKey: recipient },
        update: {},
      });

      // Create or re-sync the stream record.
      await tx.stream.upsert({
        where: { streamId },
        create: {
          streamId,
          sender,
          recipient,
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          withdrawnAmount: '0',
          startTime,
          lastUpdateTime: startTime,
          isActive: true,
        },
        update: {
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          startTime,
          lastUpdateTime: startTime,
          isActive: true,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'CREATED',
          amount: depositedAmount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp: startTime,
          metadata: JSON.stringify({ tokenAddress, ratePerSecond }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.created', {
      streamId,
      sender,
      recipient,
      tokenAddress,
      ratePerSecond,
      depositedAmount,
      startTime,
      transactionHash: event.txHash,
      ledger: event.ledger,
    });

    logger.info(`[SorobanWorker] StreamCreated — stream #${streamId}`);
  }

  /**
   * StreamToppedUpEvent
   * Topics : [Symbol("stream_topped_up"), U64(stream_id)]
   * Body   : Map { stream_id, sender, amount, new_deposited_amount }
   */
  private async handleStreamToppedUp(
    event: SorobanRpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['amount'] || !body['new_deposited_amount']) {
      throw new Error(`StreamToppedUp #${streamId}: missing body fields`);
    }

    const amount = decodeI128(body['amount']);
    const newDepositedAmount = decodeI128(body['new_deposited_amount']);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx) => {
      await tx.stream.update({
        where: { streamId },
        data: {
          depositedAmount: newDepositedAmount,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'TOPPED_UP',
          amount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ newDepositedAmount }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.topped_up', {
      streamId,
      amount,
      newDepositedAmount,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });

    logger.info(
      `[SorobanWorker] StreamToppedUp — stream #${streamId}, amount: ${amount}`,
    );
  }

  /**
   * TokensWithdrawnEvent
   * Topics : [Symbol("tokens_withdrawn"), U64(stream_id)]
   * Body   : Map { stream_id, recipient, amount, timestamp }
   */
  private async handleTokensWithdrawn(
    event: SorobanRpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['recipient'] || !body['amount'] || !body['timestamp']) {
      throw new Error(`TokensWithdrawn #${streamId}: missing body fields`);
    }

    const recipient = decodeAddress(body['recipient']);
    const amount = decodeI128(body['amount']);
    const timestamp = Number(decodeU64(body['timestamp']));

    await prisma.$transaction(async (tx) => {
      // Accumulate the withdrawn total.
      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { withdrawnAmount: true },
      });

      const newWithdrawnAmount = (
        BigInt(stream.withdrawnAmount) + BigInt(amount)
      ).toString();

      await tx.stream.update({
        where: { streamId },
        data: {
          withdrawnAmount: newWithdrawnAmount,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'WITHDRAWN',
          amount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ recipient }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.withdrawn', {
      streamId,
      recipient,
      amount,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });

    logger.info(
      `[SorobanWorker] TokensWithdrawn — stream #${streamId}, amount: ${amount}`,
    );
  }

  /**
   * StreamCancelledEvent
   * Topics : [Symbol("stream_cancelled"), U64(stream_id)]
   * Body   : Map { stream_id, sender, recipient, amount_withdrawn,
   *                refunded_amount }
   */
  private async handleStreamCancelled(
    event: SorobanRpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['amount_withdrawn'] || !body['refunded_amount']) {
      throw new Error(`StreamCancelled #${streamId}: missing body fields`);
    }

    const amountWithdrawn = decodeI128(body['amount_withdrawn']);
    const refundedAmount = decodeI128(body['refunded_amount']);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx) => {
      await tx.stream.update({
        where: { streamId },
        data: {
          isActive: false,
          withdrawnAmount: amountWithdrawn,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'CANCELLED',
          amount: refundedAmount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ amountWithdrawn, refundedAmount }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.cancelled', {
      streamId,
      refundedAmount,
      amountWithdrawn,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });

    logger.info(`[SorobanWorker] StreamCancelled — stream #${streamId}`);
  }
}

export const sorobanEventWorker = new SorobanEventWorker();
