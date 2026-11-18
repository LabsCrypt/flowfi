import type { Request, Response } from 'express';
import { getTokenMetadata, listVerifiedTokens } from '../services/token-registry.service.js';
import { sendApiError } from '../types/api-error.js';
import type { TokenMetadata as RegistryTokenMetadata } from '../services/token-registry.service.js';

export function toPublicTokenMetadata(token: RegistryTokenMetadata) {
  return {
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    contractAddress: token.contractAddress,
    type: token.symbol === 'XLM' ? 'native' : token.symbol.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    ...(token.iconUrl ? { icon: token.iconUrl } : {}),
    description: token.name,
    verified: token.isVerified,
  };
}

export async function listTokens(_req: Request, res: Response): Promise<void> {
  try { res.json({ tokens: (await listVerifiedTokens()).map(toPublicTokenMetadata) }); } catch { sendApiError(res, 500, 'token_list_failed', 'Unable to load verified tokens'); }
}
export async function getToken(req: Request, res: Response): Promise<void> {
  const address = req.params.address;
  if (typeof address !== 'string') {
    sendApiError(res, 400, 'invalid_token_address', 'A valid Soroban contract address is required');
    return;
  }
  try { res.json({ token: toPublicTokenMetadata(await getTokenMetadata(address)) }); } catch (error) {
    const apiError = error as { statusCode?: number; code?: string; message?: string };
    if (apiError.statusCode) { sendApiError(res, apiError.statusCode, apiError.code ?? 'token_lookup_failed', apiError.message ?? 'Unable to resolve token'); return; }
    sendApiError(res, 500, 'token_lookup_failed', 'Unable to resolve token metadata');
  }
}
