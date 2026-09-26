/**
 * Workers registry
 *
 * Exports a single `startWorkers` function that is called from the main server
 * entry-point after the database connection is confirmed healthy.
 */

import { sorobanEventWorker } from "./soroban-event-worker.js";
import { startStreamRunwayWorker } from "./stream-runway-worker.js";
import logger from "../logger.js";

let runwayWorkerTimer: NodeJS.Timeout | null = null;

export async function startWorkers(): Promise<void> {
  logger.info("[Workers] Starting background workers...");
  await sorobanEventWorker.start();

  // Start stream runway alert worker (Issue #1190)
  runwayWorkerTimer = startStreamRunwayWorker();
}

export function stopWorkers(): void {
  sorobanEventWorker.stop();

  if (runwayWorkerTimer) {
    clearInterval(runwayWorkerTimer);
    runwayWorkerTimer = null;
    logger.info("[Workers] Stream runway worker stopped");
  }
}
