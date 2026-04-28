import { Redis } from 'ioredis';
import logger from '../logger.js';

const REDIS_URL = process.env.REDIS_URL;

let _publisher: Redis | null = null;
let _subscriber: Redis | null = null;
let _available = false;

export function getPublisher(): Redis | null {
  return _publisher;
}

export function getSubscriber(): Redis | null {
  return _subscriber;
}

export function isRedisAvailable(): boolean {
  return _available;
}

function makeClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 2000)),
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export async function connectRedis(): Promise<void> {
  if (!REDIS_URL) {
    logger.info('[Redis] REDIS_URL not set — running in single-instance SSE mode.');
    return;
  }

  try {
    const publisher = makeClient(REDIS_URL);
    const subscriber = makeClient(REDIS_URL);

    await Promise.all([publisher.connect(), subscriber.connect()]);
    _publisher = publisher;
    _subscriber = subscriber;
    _available = true;
    logger.info('[Redis] Connected — horizontal SSE scaling enabled.');
  } catch (err) {
    logger.warn('[Redis] Connection failed — falling back to single-instance SSE mode:', err);
    _publisher?.disconnect();
    _subscriber?.disconnect();
    _publisher = null;
    _subscriber = null;
    _available = false;
  }
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([_publisher?.quit(), _subscriber?.quit()]);
  _publisher = null;
  _subscriber = null;
  _available = false;
}
