import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletProvider, useWallet } from './wallet-context';
import type { WalletSession } from '@/lib/wallet';

const STORAGE_KEY = 'flowfi.wallet.session.v1';

const mockSession: WalletSession = {
  walletId: 'freighter',
  walletName: 'Freighter',
  publicKey: 'GABC1234567890DEF',
  connectedAt: new Date().toISOString(),
  network: 'Testnet',
  mocked: false,
};

vi.mock('@/lib/wallet', () => ({
  SUPPORTED_WALLETS: [
    {
      id: 'freighter',
      name: 'Freighter',
      badge: 'Extension',
      description: 'Direct browser wallet',
    },
  ],
  connectWallet: vi.fn(),
  toWalletErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : 'Wallet connection failed'
  ),
}));

// The provider now reads signer/threshold information from Horizon once a
// session exists (issue #1471). Stub it so these unit tests never hit the
// network; the multisig behaviour itself is covered by dedicated tests below.
vi.mock('@/lib/stellar-multisig', () => ({
  fetchMultisigAccount: vi.fn().mockResolvedValue({
    publicKey: 'GABC1234567890DEF',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    sequence: '1',
    signers: [
      { key: 'GABC1234567890DEF', weight: 1, type: 'ed25519_public_key' },
    ],
    thresholds: { low: 1, medium: 1, high: 1 },
    masterWeight: 1,
    isMultisig: false,
    connectedSignerWeight: 1,
    fetchedAt: new Date().toISOString(),
  }),
}));

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <WalletProvider>{children}</WalletProvider>;
  };
}

describe('WalletProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('hydrate', () => {
    it('should restore a valid stored session as connected', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
    });

    it('should discard a malformed session', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ invalid: true }));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('should recover from syntactically invalid stored JSON without crashing', async () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json,,,');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(result.current.errorMessage).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should discard a stored session that parses to a non-object value', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify('just-a-string'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should discard a session with mocked !== false', async () => {
      const mockedSession = { ...mockSession, mocked: true };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockedSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });
  });

  describe('storage', () => {
    it('restores a valid stored session as connected', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
    });

    it('leaves the app idle when the storage key is missing', async () => {
      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('discards an empty-string value', async () => {
      localStorage.setItem(STORAGE_KEY, '');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('discards a whitespace-only value', async () => {
      localStorage.setItem(STORAGE_KEY, '   \t\n  ');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('discards JSON null', async () => {
      localStorage.setItem(STORAGE_KEY, 'null');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('discards a JSON number', async () => {
      localStorage.setItem(STORAGE_KEY, '42');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('discards a JSON string', async () => {
      localStorage.setItem(STORAGE_KEY, '"just a string"');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    const missingFieldCases = [
      { label: 'walletId', key: 'walletId' },
      { label: 'walletName', key: 'walletName' },
      { label: 'publicKey', key: 'publicKey' },
      { label: 'connectedAt', key: 'connectedAt' },
      { label: 'network', key: 'network' },
    ] as const;

    for (const { label, key } of missingFieldCases) {
      it(`discards a session missing ${label}`, async () => {
        const partial = { ...mockSession };
        delete partial[key];

        localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));

        const { result } = renderHook(() => useWallet(), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isHydrated).toBe(true);
        });

        expect(result.current.status).toBe('idle');
        expect(result.current.session).toBeNull();
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      });
    }

    it('discards a session with an incorrect walletId type', async () => {
      const bad = { ...mockSession, walletId: 123 };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(bad));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('discards a session with an incorrect connectedAt type', async () => {
      const bad = { ...mockSession, connectedAt: 1234567890 };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(bad));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('discards a session with mocked of the wrong type', async () => {
      const bad = { ...mockSession, mocked: 'false' };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(bad));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('ignores an outdated v0 wallet session key', async () => {
      localStorage.setItem('flowfi.wallet.session.v0', JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('ignores a future v2 wallet session key', async () => {
      localStorage.setItem('flowfi.wallet.session.v2', JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('ignores a non-wallet object under the current v1 key', async () => {
      localStorage.setItem(STORAGE_KEY, '{}');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });
  });

  describe('storage failures', () => {
    let getItemSpy: ReturnType<typeof vi.spyOn> | undefined;
    let setItemSpy: ReturnType<typeof vi.spyOn> | undefined;
    let removeItemSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      localStorage.clear();
      vi.clearAllMocks();
    });

    afterEach(() => {
      getItemSpy?.mockRestore();
      setItemSpy?.mockRestore();
      removeItemSpy?.mockRestore();
      localStorage.clear();
    });

    it('propagates a failing localStorage.getItem to the caller', () => {
      getItemSpy = vi.spyOn(window.localStorage, 'getItem') as unknown as ReturnType<typeof vi.spyOn>;
      getItemSpy!.mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      // Production readStoredSession keeps window.localStorage.getItem(STORAGE_KEY)
      // outside its try/catch, so a failing read propagates out of the effect.
      // This test documents that actual behaviour.
      let threw = false;
      let error: unknown;
      expect(() => {
        try {
          renderHook(() => useWallet(), {
            wrapper: createWrapper(),
          });
        } catch (e) {
          threw = true;
          error = e;
        }
      }).not.toThrow();

      expect(threw).toBe(true);
      expect(error).toEqual(new Error('Quota exceeded'));
    });

    it('converts a failed setItem into connect:error and removes the stale session', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      setItemSpy = vi.spyOn(window.localStorage, 'setItem');
      setItemSpy!.mockImplementationOnce(() => {
        throw new Error('Quota exceeded');
      });
      vi.mocked(connectWallet).mockResolvedValue(mockSession);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('error');
      expect(result.current.session).toBeNull();
      expect(result.current.errorMessage).toBe('Quota exceeded');
    });

    it('propagates removeItem failures during disconnect', () => {
      const removeItemSpy = vi.spyOn(window.localStorage, 'removeItem');
      removeItemSpy.mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(() => {
        act(() => {
          result.current.disconnect();
        });
      }).toThrow('Quota exceeded');

      removeItemSpy.mockRestore();
    });
  });

  describe('recovery followed by valid interaction', () => {
    it('discards a malformed session and restores a valid one on connect', async () => {
      localStorage.setItem(STORAGE_KEY, '{truncated');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();

      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValue(mockSession);

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(mockSession));
    });
  });

  describe('useWallet outside provider', () => {
    it('should throw when used outside WalletProvider', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useWallet());
      }).toThrow('useWallet must be used within WalletProvider.');

      consoleSpy.mockRestore();
    });
  });
});
