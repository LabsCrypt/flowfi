import type { NextFunction, Request, Response } from 'express';
import { sendApiError } from '../lib/api-error.js';
import logger from '../logger.js';

/**
 * Refuse any request that carries a Stellar secret key anywhere in it
 * (issue #1845).
 *
 * FlowFi is moving to client-side signing (issue #1274): the wallet signs, the
 * backend relays. Accepting an `S…`/`M…` secret key in a body, query string,
 * path segment, or header would put every stream in the system one leaked
 * request log, proxy trace, or heap dump away from an attacker who could then
 * move those users' funds — the exact blast radius issue #1274 set out to
 * reduce. This middleware makes "the backend never sees your private key" a
 * property of the API surface rather than a per-endpoint convention.
 *
 * Matching is on shape, not field name, so a renamed field cannot smuggle a key
 * past it. Public keys (`G…`), contract IDs (`C…`) and base64 transaction XDR
 * are structurally different and are unaffected.
 */

/** Classic ed25519 strkey secret (56 chars) or med25519 secret (94 chars). */
const SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$|^M[A-Z2-7]{93}$/;

/** How deep nested JSON is walked before giving up. */
const MAX_DEPTH = 8;

const MIGRATION_HINT =
  'Sign the transaction in your wallet instead: POST /v1/streams/simulate returns an unsigned, ' +
  'footprint-annotated XDR; sign it and send the result as `signedXdr`. FlowFi never accepts a private key.';

function findSecret(value: unknown, path: string, seen: Set<object>, depth = 0): string | null {
  if (typeof value === 'string') {
    return SECRET_KEY_PATTERN.test(value) ? path : null;
  }
  if (depth >= MAX_DEPTH) return null;
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value as object)) return null;
  seen.add(value as object);

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((entry, index) => [`${path}[${index}]`, entry])
    : Object.entries(value as Record<string, unknown>);

  for (const [childPath, child] of entries) {
    const hit = findSecret(child, childPath, seen, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Location of the offending value, e.g. `body.senderSecret` — never the value. */
export function findWalletSecret(req: Request): string | null {
  for (const [location, candidate] of [
    ['query', req.query],
    ['body', req.body],
  ] as const) {
    const hit = findSecret(candidate, location, new Set());
    if (hit) return hit;
  }

  for (const segment of req.path.split('/')) {
    if (SECRET_KEY_PATTERN.test(segment)) return 'path';
  }

  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && SECRET_KEY_PATTERN.test(value)) {
      return `header.${name}`;
    }
    if (Array.isArray(value) && value.some((entry) => SECRET_KEY_PATTERN.test(entry))) {
      return `header.${name}`;
    }
  }

  return null;
}

export function rejectWalletSecrets(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const at = findWalletSecret(req);
  if (!at) {
    return next();
  }

  // Log where, never what: the value is the credential we are refusing to hold.
  logger.warn(
    `[security] Rejected request carrying a wallet secret key at ${at}: ${req.method} ${req.path}`,
  );

  sendApiError(res, 400, 'WALLET_SECRET_NOT_ACCEPTED', MIGRATION_HINT, {
    field: at,
    reason: 'The API does not accept Stellar secret keys (issue #1845).',
  });
}
