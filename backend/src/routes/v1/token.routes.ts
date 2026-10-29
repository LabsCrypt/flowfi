import { Router, type Request, type Response } from 'express';
import { getToken, toPublicTokenMetadata } from '../../controllers/token.controller.js';
import { createHash } from 'node:crypto';
import { listVerifiedTokens } from '../../services/token-registry.service.js';
import { sendApiError } from '../../types/api-error.js';

const router = Router();

/**
 * Verified token metadata is effectively static, so it is safe to let browsers
 * and CDNs reuse it for an hour while serving stale content for a day in the
 * background (`stale-while-revalidate`). The `ETag` below lets a client skip
 * the body entirely with a conditional `If-None-Match` request.
 */
export const TOKEN_CACHE_CONTROL =
  'public, max-age=3600, stale-while-revalidate=86400';

/**
 * Strong ETag derived from the serialized payload. Anything that changes the
 * metadata (or its version marker) changes the hash, so a client revalidating
 * with a stale ETag gets fresh content — i.e. updates invalidate the cache.
 */
export function computeTokensEtag(body: string): string {
  const hash = createHash('sha1').update(body).digest('base64url');
  return `"${hash}"`;
}

/** RFC 7232 `If-None-Match` matching, including `*` and weak validators. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (header === '*') return true;

  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * @openapi
 * /v1/tokens:
 *   get:
 *     tags:
 *       - Tokens
 *     summary: List verified token metadata
 *     description: |
 *       Returns symbol, name, decimals, contract address and icon for every
 *       verified Stellar asset. The response carries an `ETag` and a
 *       `Cache-Control` header; clients should revalidate with
 *       `If-None-Match` and accept a `304 Not Modified` while the metadata is
 *       unchanged.
 *     responses:
 *       200:
 *         description: Verified token metadata
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *             description: public, max-age=3600, stale-while-revalidate=86400
 *           ETag:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokens:
 *                   type: array
 *                   items:
 *                     type: object
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *       304:
 *         description: Not Modified - the caller's cached copy is still current
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Reuse the same persisted verified registry as detail lookups. The
    // registry rows carry updatedAt, which makes the ETag change on writes.
    const registryTokens = await listVerifiedTokens();
    const tokens = registryTokens.map(toPublicTokenMetadata);
    const updatedAt = registryTokens.reduce<Date>((latest, token) =>
      token.updatedAt > latest ? token.updatedAt : latest, new Date(0));
    const body = JSON.stringify({ tokens, updatedAt: updatedAt.toISOString() });
    const etag = computeTokensEtag(body);

    res.setHeader('Cache-Control', TOKEN_CACHE_CONTROL);
    res.setHeader('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).type('application/json').send(body);
  } catch {
    sendApiError(res, 500, 'token_list_failed', 'Unable to load verified tokens');
  }
});

router.get('/:address', getToken);

export default router;
