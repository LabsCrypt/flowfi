// Example: How to integrate SSE with your blockchain indexer

import { sseService } from '../services/sse.service.js';

/**
 * Example indexer event handler
 * Call this when your indexer detects new blockchain events
 */
export function handleBlockchainEvent(event: any) {
  switch (event.eventType) {
    case 'CREATED':
      sseService.broadcastToStream(
        event.streamId.toString(),
        'stream.created',
        {
          streamId: event.streamId,
          sender: event.sender,
          recipient: event.recipient,
          tokenAddress: event.tokenAddress,
          ratePerSecond: event.ratePerSecond,
          depositedAmount: event.depositedAmount,
          startTime: event.startTime,
          transactionHash: event.transactionHash,
        }
      );
      break;

    case 'TOPPED_UP':
      sseService.broadcastToStream(
        event.streamId.toString(),
        'stream.topped_up',
        {
          streamId: event.streamId,
          amount: event.amount,
          newBalance: event.newBalance,
          transactionHash: event.transactionHash,
          timestamp: event.timestamp,
        }
      );
      break;

    case 'WITHDRAWN':
      sseService.broadcastToStream(
        event.streamId.toString(),
        'stream.withdrawn',
        {
          streamId: event.streamId,
          amount: event.amount,
          recipient: event.recipient,
          transactionHash: event.transactionHash,
          timestamp: event.timestamp,
        }
      );
      break;

    case 'CANCELLED':
      sseService.broadcastToStream(
        event.streamId.toString(),
        'stream.cancelled',
        {
          streamId: event.streamId,
          refundedAmount: event.refundedAmount,
          transactionHash: event.transactionHash,
          timestamp: event.timestamp,
        }
      );
      break;

    case 'COMPLETED':
      sseService.broadcastToStream(
        event.streamId.toString(),
        'stream.completed',
        {
          streamId: event.streamId,
          totalStreamed: event.totalStreamed,
          timestamp: event.timestamp,
        }
      );
      break;
  }
}

/**
 * Example: Integrate with Stellar event listener
 */
export function setupStellarEventListener() {
  // Pseudo-code - replace with actual Stellar SDK integration
  
  // stellar.events.on('StreamCreated', (event) => {
  //   handleBlockchainEvent({
  //     eventType: 'CREATED',
  //     streamId: event.stream_id,
  //     sender: event.sender,
  //     recipient: event.recipient,
  //     tokenAddress: event.token,
  //     ratePerSecond: event.rate_per_second,
  //     depositedAmount: event.deposited_amount,
  //     startTime: event.start_time,
  //     transactionHash: event.tx_hash,
  //   });
  // });

  // stellar.events.on('StreamWithdrawn', (event) => {
  //   handleBlockchainEvent({
  //     eventType: 'WITHDRAWN',
  //     streamId: event.stream_id,
  //     amount: event.amount,
  //     recipient: event.recipient,
  //     transactionHash: event.tx_hash,
  //     timestamp: event.timestamp,
  //   });
  // });
}
