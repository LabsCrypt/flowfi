import { rpc, xdr, StrKey } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma.js';
import { sseService } from '../services/sse.service.js';
import logger from '../logger.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const INDEXER_STATE_ID = 'singleton';

// ─── XDR Decoding Helpers ────────────────────────────────────────────────────

/** Decode an ScVal symbol to a string. */
export function decodeSymbol(val: xdr.ScVal): string {
  return val.sym().toString();
}

/**
 * Decode an ScVal U64 to a JavaScript bigint.
 * `xdr.UInt64` extends Long; `.toString()` gives the decimal representation.
 */
export function decodeU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/**
 * Decode an ScVal I128 to a decimal string suitable for DB storage.
 * I128 in XDR is split into hi (signed Int64) and lo (unsigned Uint64).
 * Full value = hi * 2^64 + lo.
 */
export function decodeI128(val: xdr.ScVal): string {
  const parts = val.i128();
  const hi = BigInt.asIntN(64, BigInt(parts.hi().toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  return ((hi << 64n) | lo).toString();
}

/**
 * Decode an ScVal Address to a Stellar public key (G...) or contract (C...)
 * string.
 */
export function decodeAddress(val: xdr.ScVal): string {
  const addr = val.address();
  if (
    addr.switch().value ===
    xdr.ScAddressType.scAddressTypeAccount().value
  ) {
    return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
  }
  // addr.contractId() returns a Hash (Opaque[]), convert to Buffer for encodeContract
  return StrKey.encodeContract(Buffer.from(addr.contractId() as any));
}

/**
 * Decode an ScVal Map (a `#[contracttype]` struct) into a plain object keyed
 * by field name with raw ScVal values for further decoding.
 */
export function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
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
  private readonly server: rpc.Server;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number;

  private isRunning = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private activeBatch: Promise<void> | null = null;

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
    this.server = new rpc.Server(rpcUrl, { allowHttp: true });
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

  /** Wait for the currently-running poll batch to finish (no-op if idle). */
  async waitForDrain(): Promise<void> {
    if (this.activeBatch) await this.activeBatch;
  }

  /** Trigger an immediate poll cycle (used for replay and manual updates). */
  async triggerPoll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.fetchAndProcessEvents();
    } catch (err) {
      logger.error('[SorobanWorker] Manual poll error:', err);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    this.activeBatch = this.fetchAndProcessEvents().catch((err) => {
      logger.error('[SorobanWorker] Unhandled error during poll:', err);
    });
    try {
      await this.activeBatch;
    } finally {
      this.activeBatch = null;
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
    } satisfies Omit<Parameters<rpc.Server['getEvents']>[0], 'startLedger' | 'cursor'>;

    // Prefer cursor-based pagination after the first poll so we never
    // re-process events.
    const params: Parameters<rpc.Server['getEvents']>[0] =
      state.lastCursor
        ? { ...baseFilter, cursor: state.lastCursor }
        : { ...baseFilter, startLedger: state.lastLedger || this.startLedger };

    const response = await this.server.getEvents(params);

    if (response.events.length === 0) return;

    let lastCursor: string | null = state.lastCursor;
    let lastLedger: number = state.lastLedger;

    // Sort events so that 'stream_created' events are processed first in the batch.
    // This ensures that subsequent events (like 'fee_collected') that depend on
    // the stream existing in the DB can find it.
    const sortedEvents = [...response.events].sort((a, b) => {
      const aType = a.topic[0] ? decodeSymbol(a.topic[0]) : '';
      const bType = b.topic[0] ? decodeSymbol(b.topic[0]) : '';
      if (aType === 'stream_created' && bType !== 'stream_created') return -1;
      if (bType === 'stream_created' && aType !== 'stream_created') return 1;
      return 0;
    });

    for (const event of sortedEvents) {
      // Only process events from successful contract calls.
      if (!event.inSuccessfulContractCall) continue;

      try {
        await this.processEvent(event);
        // Use the event ID as the cursor if pagingToken is not available
        lastCursor = event.id;
        lastLedger = event.ledger;
      } catch (err) {
        logger.error(
          `[SorobanWorker] Failed to process event ${event.id}:`,
          err,
        );
        // Continue processing subsequent events rather than halting.
      }
    }

    // Use the response's final cursor if provided, otherwise the last event's ID
    const finalCursor = (response as any).latestCursor || lastCursor;

    await prisma.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: {
        id: INDEXER_STATE_ID,
        lastLedger,
        lastCursor: finalCursor,
      },
      update: { lastLedger, lastCursor: finalCursor },
    });

    logger.info(
      `[SorobanWorker] Processed ${response.events.length} event(s) — latest ledger: ${lastLedger}`,
    );
  }

  /**
   * Dispatch a single contract event to the appropriate handler based on the
   * first topic symbol.
   */
  public async processEvent(
    event: rpc.Api.EventResponse,
  ): Promise<void> {
    if (!event.topic || event.topic.length < 2) return;

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
      case 'stream_paused':
        await this.handleStreamPaused(event, topic1);
        break;
      case 'stream_resumed':
        await this.handleStreamResumed(event, topic1);
        break;
      case 'stream_cancelled':
        await this.handleStreamCancelled(event, topic1);
        break;
      case 'stream_completed':
        await this.handleStreamCompleted(event, topic1);
        break;
      case 'fee_collected':
        await this.handleFeeCollected(event, topic1);
        break;
      case 'stream_paused':
        await this.handleStreamPaused(event, topic1);
        break;
      case 'stream_resumed':
        await this.handleStreamResumed(event, topic1);
        break;
      default:
        // Unrecognised event — ignore silently.
        break;
    }
  }

  // ─── Event Handlers ────────────────────────────────────────────────────────

  private async handleStreamCreated(
    event: rpc.Api.EventResponse,
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
    
    // Compute expected end time (assuming no pauses yet)
    const durationSeconds = Number(BigInt(depositedAmount) / BigInt(ratePerSecond));
    const endTime = startTime + durationSeconds;

    await prisma.$transaction(async (tx: any) => {
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
          endTime,
          lastUpdateTime: startTime,
          isActive: true,
        },
        update: {
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          startTime,
          endTime,
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
  }

  private async handleStreamToppedUp(
    event: rpc.Api.EventResponse,
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

    await prisma.$transaction(async (tx: any) => {
      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { ratePerSecond: true, startTime: true, totalPausedDuration: true }
      });
      
      const durationSeconds = Number(BigInt(newDepositedAmount) / BigInt(stream.ratePerSecond));
      const newEndTime = stream.startTime + durationSeconds + stream.totalPausedDuration;

      await tx.stream.update({
        where: { streamId },
        data: {
          depositedAmount: newDepositedAmount,
          endTime: newEndTime,
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
  }

  private async handleStreamPaused(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: true,
          lastPausedAt: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'PAUSED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.paused', {
      streamId,
      isPaused: true,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleStreamResumed(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { totalPausedSeconds: true, lastPausedAt: true },
      });

      const lastPausedAt = stream.lastPausedAt ?? timestamp;
      const pausedDuration = Math.max(0, timestamp - lastPausedAt);
      const nextTotalPausedSeconds = stream.totalPausedSeconds + pausedDuration;

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: false,
          totalPausedSeconds: nextTotalPausedSeconds,
          lastPausedAt: null,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'RESUMED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.resumed', {
      streamId,
      isPaused: false,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleTokensWithdrawn(
    event: rpc.Api.EventResponse,
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

    await prisma.$transaction(async (tx: any) => {
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
  }

  private async handleStreamCancelled(
    event: rpc.Api.EventResponse,
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

    await prisma.$transaction(async (tx: any) => {
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
  }

  private async handleStreamCompleted(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['recipient'] || !body['total_withdrawn']) {
      throw new Error(`StreamCompleted #${streamId}: missing body fields`);
    }

    const recipient = decodeAddress(body['recipient']);
    const totalWithdrawn = decodeI128(body['total_withdrawn']);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      await tx.stream.update({
        where: { streamId },
        data: {
          isActive: false,
          withdrawnAmount: totalWithdrawn,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'COMPLETED',
          amount: totalWithdrawn,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ recipient }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.completed', {
      streamId,
      recipient,
      totalWithdrawn,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleFeeCollected(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['treasury'] || !body['fee_amount'] || !body['token']) {
      throw new Error(`FeeCollected #${streamId}: missing body fields`);
    }

    const treasury = decodeAddress(body['treasury']);
    const feeAmount = decodeI128(body['fee_amount']);
    const token = decodeAddress(body['token']);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.streamEvent.create({
      data: {
        streamId,
        eventType: 'FEE_COLLECTED',
        amount: feeAmount,
        transactionHash: event.txHash,
        ledgerSequence: event.ledger,
        timestamp,
        metadata: JSON.stringify({ treasury, token }),
      },
    });

    // Broadcast to admin channel for treasury reporting
    sseService.broadcastToAdmin('stream.fee_collected', {
      streamId,
      treasury,
      feeAmount,
      token,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleStreamPaused(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['sender'] || !body['paused_at']) {
      throw new Error(`StreamPaused #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body['sender']);
    const pausedAt = Number(decodeU64(body['paused_at']));

    await prisma.$transaction(async (tx: any) => {
      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: true,
          pausedAt,
          lastUpdateTime: pausedAt,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'PAUSED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp: pausedAt,
          metadata: JSON.stringify({ sender }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.paused', {
      streamId,
      sender,
      pausedAt,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp: pausedAt,
    });
  }

  private async handleStreamResumed(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['sender'] || !body['new_end_time']) {
      throw new Error(`StreamResumed #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body['sender']);
    const newEndTime = Number(decodeU64(body['new_end_time']));
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { pausedAt: true, totalPausedDuration: true },
      });

      const pausedAt = stream.pausedAt || timestamp;
      const pausedDuration = timestamp - pausedAt;

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: false,
          pausedAt: null,
          endTime: newEndTime,
          totalPausedDuration: {
            increment: pausedDuration,
          },
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'RESUMED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ sender, newEndTime, pausedDuration }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.resumed', {
      streamId,
      sender,
      newEndTime,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleStreamPaused(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['sender'] || !body['paused_at']) {
      throw new Error(`StreamPaused #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body['sender']);
    const pausedAt = Number(decodeU64(body['paused_at']));
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      // Get current stream to preserve totalPausedDuration
      const currentStream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { totalPausedDuration: true },
      });

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: true,
          pausedAt,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'PAUSED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ sender, pausedAt }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.paused', {
      streamId,
      sender,
      pausedAt,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleStreamResumed(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = Number(decodeU64(streamIdTopic));
    const body = decodeMap(event.value);

    if (!body['sender'] || !body['new_end_time']) {
      throw new Error(`StreamResumed #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body['sender']);
    const newEndTime = Number(decodeU64(body['new_end_time']));
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: any) => {
      // Get current stream to calculate paused duration
      const currentStream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { pausedAt: true, totalPausedDuration: true },
      });

      // Calculate the duration of this pause interval
      let additionalPausedDuration = 0;
      if (currentStream.pausedAt) {
        additionalPausedDuration = timestamp - currentStream.pausedAt;
      }

      const newTotalPausedDuration = currentStream.totalPausedDuration + additionalPausedDuration;

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: false,
          pausedAt: null,
          totalPausedDuration: newTotalPausedDuration,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.create({
        data: {
          streamId,
          eventType: 'RESUMED',
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ 
            sender, 
            newEndTime, 
            pausedDuration: additionalPausedDuration,
            totalPausedDuration: newTotalPausedDuration 
          }),
        },
      });
    });

    sseService.broadcastToStream(String(streamId), 'stream.resumed', {
      streamId,
      sender,
      newEndTime,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }
}

export const sorobanEventWorker = new SorobanEventWorker();
