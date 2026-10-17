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

  describe('connect', () => {
    it('should dispatch connect:success and store session on success', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValue(mockSession);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(mockSession));
    });

    it('should dispatch connect:error and clear stored session on failure', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockRejectedValue(new Error('Connection failed'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toBe('Connection failed');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('disconnect', () => {
    it('should clear state and remove localStorage key', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValue(mockSession);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('multisig detection', () => {
    it('exposes the detected multisig state after a session is restored', async () => {
      const { fetchMultisigAccount } = await import('@/lib/stellar-multisig');
      vi.mocked(fetchMultisigAccount).mockResolvedValueOnce({
        publicKey: mockSession.publicKey,
        networkPassphrase: 'Test SDF Network ; September 2015',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        sequence: '1',
        signers: [
          { key: mockSession.publicKey, weight: 1, type: 'ed25519_public_key' },
          { key: 'GCO-SIGNER', weight: 1, type: 'ed25519_public_key' },
        ],
        thresholds: { low: 1, medium: 1, high: 2 },
        masterWeight: 1,
        isMultisig: true,
        connectedSignerWeight: 1,
        fetchedAt: new Date().toISOString(),
      });

      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      expect(result.current.multisig.isMultisig).toBe(true);
      expect(result.current.multisig.account?.signers).toHaveLength(2);
    });

    it('records a Horizon failure without dropping the wallet session', async () => {
      const { fetchMultisigAccount } = await import('@/lib/stellar-multisig');
      vi.mocked(fetchMultisigAccount).mockRejectedValueOnce(new Error('horizon down'));

      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.multisig.status).toBe('error');
      });

      expect(result.current.multisig.error).toBe('horizon down');
      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
    });

    it('resets multisig state on disconnect', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.multisig).toMatchObject({
        status: 'idle',
        account: null,
        isMultisig: false,
      });
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
