import { describe, it, expect } from 'vitest';
import { decodeSymbol, decodeU64, decodeI128, decodeAddress, decodeMap } from '../src/workers/soroban-event-worker.js';
import { xdr, StrKey } from '@stellar/stellar-sdk';

describe('Soroban Event Worker Helpers', () => {
  it('should decode symbol', () => {
    const val = xdr.ScVal.scvSymbol('test');
    expect(decodeSymbol(val)).toBe('test');
  });

  it('should decode u64', () => {
    const val = xdr.ScVal.scvU64(new xdr.Uint64(123n));
    expect(decodeU64(val)).toBe(123n);
  });

  it('should decode i128', () => {
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({
      hi: new xdr.Int64(0n),
      lo: new xdr.Uint64(456n)
    }));
    expect(decodeI128(val)).toBe('456');
  });

  it('should decode address', () => {
    const accountId = 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY';
    const addr = xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId))
    );
    const val = xdr.ScVal.scvAddress(addr);
    expect(decodeAddress(val)).toBe(accountId);
  });

  it('should decode map', () => {
    const entries = [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('key1'),
        val: xdr.ScVal.scvU64(new xdr.Uint64(1n))
      })
    ];
    const val = xdr.ScVal.scvMap(entries);
    const decoded = decodeMap(val);
    expect(decoded.key1).toBeDefined();
    expect(decodeU64(decoded.key1!)).toBe(1n);
  });
});
