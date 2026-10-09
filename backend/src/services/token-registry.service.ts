import { Account, Asset, Contract, Keypair, Networks, rpc, scValToNative, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma.js';
import { getPublisher } from '../lib/redis.js';
import { rpcPool } from '../lib/rpc-pool.js';
import { ApiError } from '../types/api-error.js';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = 'token-registry:v1';
type TokenMetadata = {
  id: string; contractAddress: string; symbol: string; name: string; decimals: number;
  iconUrl: string | null; issuerAddress: string | null; isVerified: boolean; createdAt: Date; updatedAt: Date;
};
function networkPassphrase(): string { return process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET; }
function cacheKey(address: string): string { return `${CACHE_PREFIX}:${process.env.STELLAR_NETWORK ?? 'testnet'}:${address}`; }
async function redisGet(address: string): Promise<TokenMetadata | null> {
  const redis = getPublisher(); if (!redis) return null;
  try { const value = await redis.get(cacheKey(address)); return value ? JSON.parse(value) as TokenMetadata : null; } catch { return null; }
}
async function redisSet(metadata: TokenMetadata): Promise<void> {
  const redis = getPublisher(); if (!redis) return;
  try { await redis.set(cacheKey(metadata.contractAddress), JSON.stringify(metadata), 'EX', CACHE_TTL_SECONDS); } catch { /* PostgreSQL remains the durable cache. */ }
}
async function invoke(address: string, method: 'symbol' | 'decimals' | 'name'): Promise<unknown> {
  return rpcPool.execute(`token ${method}`, async (server) => {
    const source = new Account(Keypair.random().publicKey(), '0');
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: networkPassphrase() })
      .addOperation(new Contract(address).call(method)).setTimeout(30).build();
    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) throw new Error(`Contract does not expose ${method}`);
    const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) throw new Error(`Contract does not expose ${method}`);
    return scValToNative(retval);
  });
}
async function resolveSac(address: string, symbol: string): Promise<{ symbol: string; issuerAddress: string | null } | null> {
  if (Asset.native().contractId(networkPassphrase()) === address) return { symbol: 'XLM', issuerAddress: null };
  const baseUrl = process.env.STELLAR_HORIZON_URL; if (!baseUrl) return null;
  // Compare deterministic SAC contract IDs derived from Horizon asset records.
  let next: string | null = `${baseUrl.replace(/\/$/, '')}/assets?asset_code=${encodeURIComponent(symbol)}&limit=200&order=asc`;
  while (next) {
    const response = await fetch(next); if (!response.ok) throw new Error(`Horizon lookup failed (${response.status})`);
    const page = await response.json() as {
      _links?: { next?: { href?: string } };
      _embedded?: { records?: Array<{ asset_code: string; asset_issuer: string }> };
    };
    for (const asset of page._embedded?.records ?? []) {
      try {
        if (new Asset(asset.asset_code, asset.asset_issuer).contractId(networkPassphrase()) === address) return { symbol: asset.asset_code, issuerAddress: asset.asset_issuer };
      } catch { /* Skip malformed Horizon records. */ }
    }
    const candidate = page._links?.next?.href; next = candidate && candidate !== next ? candidate : null;
  }
  return null;
}
export async function listVerifiedTokens(): Promise<TokenMetadata[]> {
  return prisma.tokenRegistry.findMany({ where: { isVerified: true }, orderBy: { symbol: 'asc' } });
}
export async function getTokenMetadata(address: string): Promise<TokenMetadata> {
  if (!StrKey.isValidContract(address)) throw new ApiError(400, 'invalid_token_address', 'A valid Soroban contract address is required');
  const cached = await redisGet(address); if (cached) return cached;
  const existing = await prisma.tokenRegistry.findUnique({ where: { contractAddress: address } });
  if (existing) { await redisSet(existing); return existing; }
  try {
    const [symbolValue, decimalsValue] = await Promise.all([invoke(address, 'symbol'), invoke(address, 'decimals')]);
    if (typeof symbolValue !== 'string' || !symbolValue.trim()) throw new Error('Invalid token symbol');
    const decimals = typeof decimalsValue === 'bigint' ? Number(decimalsValue) : decimalsValue;
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals');
    const nameValue = await invoke(address, 'name').catch(() => symbolValue);
    const name = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : symbolValue.trim();
    const sac = await resolveSac(address, symbolValue.trim()).catch(() => null);
    const metadata = await prisma.tokenRegistry.upsert({
      where: { contractAddress: address },
      create: { contractAddress: address, symbol: sac?.symbol ?? symbolValue.trim(), name, decimals, issuerAddress: sac?.issuerAddress ?? null, isVerified: Boolean(sac) },
      update: { symbol: sac?.symbol ?? symbolValue.trim(), name, decimals, issuerAddress: sac?.issuerAddress ?? null },
    });
    await redisSet(metadata); return metadata;
  } catch {
    throw new ApiError(502, 'token_resolution_failed', 'Unable to resolve token metadata from the Stellar network');
  }
}