import type { Request, Response } from 'express';
import { getTokenMetadata, listVerifiedTokens } from '../services/token-registry.service.js';
import { sendApiError } from '../types/api-error.js';
export async function listTokens(_req: Request, res: Response): Promise<void> {
  try { res.json({ tokens: await listVerifiedTokens() }); } catch { sendApiError(res, 500, 'token_list_failed', 'Unable to load verified tokens'); }
}
export async function getToken(req: Request, res: Response): Promise<void> {
  try { res.json({ token: await getTokenMetadata(req.params.address) }); } catch (error) {
    const apiError = error as { statusCode?: number; code?: string; message?: string };
    if (apiError.statusCode) { sendApiError(res, apiError.statusCode, apiError.code ?? 'token_lookup_failed', apiError.message ?? 'Unable to resolve token'); return; }
    sendApiError(res, 500, 'token_lookup_failed', 'Unable to resolve token metadata');
  }
}