/**
 * Workers registry
 *
 * Exports a single `startWorkers` function that is called from the main server
 * entry-point after the database connection is confirmed healthy.
 */

import { sorobanEventWorker } from './soroban-event-worker.js';
import logger from '../logger.js';

export async function startWorkers(): Promise<void> {
  logger.info('[Workers] Starting background workers...');
  await sorobanEventWorker.start();
}

export function stopWorkers(): void {
  sorobanEventWorker.stop();
}
