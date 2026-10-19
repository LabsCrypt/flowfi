/**
 * IndexedDB persistence layer for the optimistic UI engine.
 *
 * Two stores:
 *  - cached_streams: keyed by `id`, indexed by sender / recipient / tokenAddress / updatedAt
 *  - optimistic_mutations: keyed by `id`, one entry per pending user action
 */

export type StreamStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type MutationKind = 'CREATE' | 'WITHDRAW' | 'TOP_UP' | 'CANCEL' | 'PAUSE';
export type MutationStatus = 'pending' | 'confirmed' | 'failed';

export interface CachedStream {
  id: string;
  sender: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Base-unit amounts as decimal strings (bigint-safe). */
  depositedAmount: string;
  withdrawnAmount: string;
  claimableAmount: string;
  status: StreamStatus;
  updatedAt: number;
  memo?: string;
  endTimestamp?: number;
}

export interface OptimisticMutation {
  id: string;
  streamId: string;
  kind: MutationKind;
  createdAt: number;
  status: MutationStatus;
  /** Field snapshot taken before applying `patch`, used to roll back. */
  before: Partial<CachedStream>;
  patch: Partial<CachedStream>;
  error?: string;
}

export const STREAMS_STORE = 'cached_streams';
export const MUTATIONS_STORE = 'optimistic_mutations';

const DB_NAME = 'flowfi-stream-cache';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function isStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openStreamCacheDB(): Promise<IDBDatabase> {
  if (!isStorageAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STREAMS_STORE)) {
        const store = db.createObjectStore(STREAMS_STORE, { keyPath: 'id' });
        store.createIndex('sender', 'sender');
        store.createIndex('recipient', 'recipient');
        store.createIndex('tokenAddress', 'tokenAddress');
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
        db.createObjectStore(MUTATIONS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });

  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export async function getCachedStreams(): Promise<CachedStream[]> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(STREAMS_STORE, 'readonly');
  return reqToPromise(tx.objectStore(STREAMS_STORE).getAll() as IDBRequest<CachedStream[]>);
}

export async function getCachedStream(id: string): Promise<CachedStream | undefined> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(STREAMS_STORE, 'readonly');
  return reqToPromise(
    tx.objectStore(STREAMS_STORE).get(id) as IDBRequest<CachedStream | undefined>,
  );
}

export async function putCachedStream(stream: CachedStream): Promise<void> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(STREAMS_STORE, 'readwrite');
  tx.objectStore(STREAMS_STORE).put(stream);
  await txComplete(tx);
}

export async function putCachedStreams(streams: CachedStream[]): Promise<void> {
  if (streams.length === 0) return;
  const db = await openStreamCacheDB();
  const tx = db.transaction(STREAMS_STORE, 'readwrite');
  const store = tx.objectStore(STREAMS_STORE);
  for (const stream of streams) store.put(stream);
  await txComplete(tx);
}

export async function deleteCachedStream(id: string): Promise<void> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(STREAMS_STORE, 'readwrite');
  tx.objectStore(STREAMS_STORE).delete(id);
  await txComplete(tx);
}

// ---------------------------------------------------------------------------
// Optimistic mutations
// ---------------------------------------------------------------------------

export async function getOptimisticMutations(): Promise<OptimisticMutation[]> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(MUTATIONS_STORE, 'readonly');
  return reqToPromise(
    tx.objectStore(MUTATIONS_STORE).getAll() as IDBRequest<OptimisticMutation[]>,
  );
}

export async function putOptimisticMutation(mutation: OptimisticMutation): Promise<void> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(MUTATIONS_STORE, 'readwrite');
  tx.objectStore(MUTATIONS_STORE).put(mutation);
  await txComplete(tx);
}

export async function deleteOptimisticMutation(id: string): Promise<void> {
  const db = await openStreamCacheDB();
  const tx = db.transaction(MUTATIONS_STORE, 'readwrite');
  tx.objectStore(MUTATIONS_STORE).delete(id);
  await txComplete(tx);
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export async function clearStreamCache(): Promise<void> {
  const db = await openStreamCacheDB();
  const tx = db.transaction([STREAMS_STORE, MUTATIONS_STORE], 'readwrite');
  tx.objectStore(STREAMS_STORE).clear();
  tx.objectStore(MUTATIONS_STORE).clear();
  await txComplete(tx);
}
