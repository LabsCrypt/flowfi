/**
 * Minimal in-process pub/sub used by GraphQL subscriptions.
 *
 * FlowFi's real-time transport already has two producers (the SSE routes and
 * the Soroban indexer worker). Rather than depend on Redis pub/sub for the
 * GraphQL gateway — which would force a broker into every deployment and make
 * the subscription tests require infrastructure — this keeps a per-process
 * fan-out of typed topics. SSE broadcasts mirror into it (see
 * `services/sse.service.ts`), so a GraphQL subscription observes exactly the
 * same stream/event traffic as an SSE client.
 *
 * The broker is deliberately transport-agnostic: `publish` is synchronous and
 * `subscribe` returns an async iterator that the GraphQL execution engine can
 * consume directly (graphql-yoga streams it over SSE).
 */

export type Listener<T> = (payload: T) => void;

/** Topic carrying a full stream snapshot, keyed by the stream's identifier. */
export function streamTopic(streamId: string): string {
  return `stream:${streamId}`;
}

/** Topic carrying user-scoped stream events, keyed by Stellar public key. */
export function userTopic(address: string): string {
  return `user:${address}`;
}

class InMemoryPubSub {
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();

  /**
   * Broadcast `payload` to every current subscriber of `topic`.
   *
   * A throwing listener is isolated so one misbehaving subscriber (for example
   * a disconnected SSE client) can never stop delivery to the others.
   */
  publish<T>(topic: string, payload: T): void {
    const subscribers = this.listeners.get(topic);
    if (!subscribers) return;

    for (const listener of [...subscribers]) {
      try {
        listener(payload);
      } catch {
        // Subscription delivery must never propagate into the producer.
      }
    }
  }

  /** Number of live subscribers on `topic` (used by tests/observability). */
  subscriberCount(topic: string): number {
    return this.listeners.get(topic)?.size ?? 0;
  }

  /**
   * Subscribe to `topic`, returning an async iterator that yields each
   * published payload until the consumer stops iterating.
   */
  subscribe<T>(topic: string): AsyncIterableIterator<T> {
    const queue: T[] = [];
    const waiters: Array<(result: IteratorResult<T>) => void> = [];

    const listener = (payload: unknown): void => {
      const value = payload as T;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        queue.push(value);
      }
    };

    const subscribers = this.listeners.get(topic) ?? new Set<Listener<unknown>>();
    subscribers.add(listener);
    this.listeners.set(topic, subscribers);

    const cleanup = (): void => {
      subscribers.delete(listener);
      if (subscribers.size === 0) {
        this.listeners.delete(topic);
      }
      // Unblock any consumer still awaiting a payload.
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as T, done: true });
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift() as T, done: false });
        }
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<T>> {
        cleanup();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
      throw(error?: unknown): Promise<IteratorResult<T>> {
        cleanup();
        return Promise.reject(error);
      },
    };
  }
}

export const graphqlPubSub = new InMemoryPubSub();
export type GraphQLPubSub = InMemoryPubSub;
