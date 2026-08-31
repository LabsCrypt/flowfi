/**
 * Control-plane helpers for the indexer cursor.
 *
 * This barrel re-exports the real implementation from `indexer.service.ts`.
 * It is **not** an indexer — see `backend/docs/ARCHITECTURE.md` (Indexer
 * Ownership) and `docs/ARCHITECTURE.md` for the full indexer ownership model
 * and why the legacy `soroban-indexer.service.ts` exists.
 */
export * from './indexer.service.js';
