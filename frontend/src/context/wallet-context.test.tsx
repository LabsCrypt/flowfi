import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletProvider, useWallet } from './wallet-context';
import type { WalletSession } from '@/lib/wallet';
import { fetchMultisigAccount, type MultisigAccount } from '@/lib/stellar-multisig';

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
  fetchMultisigAccount: vi.fn(),
}));

// ── Deterministic helpers ───────────────────────────────────────────────────

const FIXED_CONNECTED_AT = '2025-06-01T00:00:00.000Z';
const FALLBACK_HORIZON_MESSAGE = 'Could not load signer information from Horizon.';

function makeSession(
  publicKey: string,
  overrides: Partial<WalletSession> = {},
): WalletSession {
  return {
    walletId: 'freighter',
    walletName: 'Freighter',
    publicKey,
    connectedAt: FIXED_CONNECTED_AT,
    network: 'Testnet',
    mocked: false,
    ...overrides,
  };
}

function makeAccount(
  publicKey: string,
  overrides: Partial<MultisigAccount> = {},
): MultisigAccount {
  return {
    publicKey,
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    sequence: '1',
    signers: [
      { key: publicKey, weight: 1, type: 'ed25519_public_key' },
    ],
    thresholds: { low: 1, medium: 1, high: 1 },
    masterWeight: 1,
    isMultisig: false,
    connectedSignerWeight: 1,
    fetchedAt: FIXED_CONNECTED_AT,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <WalletProvider>{children}</WalletProvider>;
  };
}

describe('WalletProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Deterministic default: signer data for whichever key is requested.
    vi.mocked(fetchMultisigAccount).mockImplementation((publicKey: string) =>
      Promise.resolve(makeAccount(publicKey)),
    );
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

  describe('account change', () => {
    it('reflects the new account and re-reads signer information for it', async () => {
      const sessionA = makeSession('GACCOUNT-AAAAAAAAAAAAAA');
      const sessionB = makeSession('GACCOUNT-BBBBBBBBBBBBBB');
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockResolvedValueOnce(sessionA)
        .mockResolvedValueOnce(sessionB);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.session).toEqual(sessionA);
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(sessionB);
      expect(result.current.selectedWalletId).toBe('freighter');
      expect(result.current.errorMessage).toBeNull();
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });
      expect(result.current.multisig.account?.publicKey).toBe(
        'GACCOUNT-BBBBBBBBBBBBBB',
      );
      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenLastCalledWith(
        'GACCOUNT-BBBBBBBBBBBBBB',
      );
      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify(sessionB),
      );
    });

    it('does not re-read signer information for a repeated connect with the same account', async () => {
      const sessionA = makeSession('GACCOUNT-SAMEAAAAAAA');
      const sessionB = makeSession('GACCOUNT-SAMEAAAAAAA');
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockResolvedValueOnce(sessionA)
        .mockResolvedValueOnce(sessionB);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });
      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenCalledTimes(1);

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenCalledTimes(1);
    });

    it('ignores an older account lookup that resolves after a newer account change', async () => {
      const accountA = makeAccount('GACCOUNT-OLDAAAAAAAAAA');
      const accountB = makeAccount('GACCOUNT-NEWBBBBBBBBBB');
      const deferredA = createDeferred<MultisigAccount>();
      const deferredB = createDeferred<MultisigAccount>();
      vi
        .mocked(fetchMultisigAccount)
        .mockImplementation((publicKey: string) =>
          publicKey === 'GACCOUNT-OLDAAAAAAAAAA'
            ? deferredA.promise
            : deferredB.promise,
        );
      const sessionA = makeSession('GACCOUNT-OLDAAAAAAAAAA');
      const sessionB = makeSession('GACCOUNT-NEWBBBBBBBBBB');
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockResolvedValueOnce(sessionA)
        .mockResolvedValueOnce(sessionB);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('loading');
      });

      // Newer account B connection while A's lookup is still pending.
      await act(async () => {
        await result.current.connect('freighter');
      });
      expect(result.current.multisig.status).toBe('loading');

      // Stale account A result lands first and must be discarded: the newer
      // account's lookup has superseded it, so no dispatch may fire.
      await act(async () => {
        deferredA.resolve(accountA);
      });
      expect(result.current.multisig.account).toBeNull();
      expect(result.current.multisig.status).toBe('loading');

      await act(async () => {
        deferredB.resolve(accountB);
      });

      expect(result.current.multisig.status).toBe('ready');
      expect(result.current.multisig.account?.publicKey).toBe(
        'GACCOUNT-NEWBBBBBBBBBB',
      );
      expect(result.current.session?.publicKey).toBe('GACCOUNT-NEWBBBBBBBBBB');
    });

    it('resets multisig state and the stored session when a reconnect fails', async () => {
      const sessionA = makeSession('GACCOUNT-FAILAAAAAAA');
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockResolvedValueOnce(sessionA)
        .mockRejectedValueOnce(new Error('wallet unplugged'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toBe('wallet unplugged');
      expect(result.current.session).toBeNull();
      expect(result.current.multisig).toMatchObject({
        status: 'idle',
        account: null,
        isMultisig: false,
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('network change', () => {
    it('carries the wallet-reported network through reconnect without dropping the session', async () => {
      const sessionTestnet = makeSession('GACCOUNT-NETAAAAAAAAAA', {
        network: 'Testnet',
      });
      const sessionMainnet = makeSession('GACCOUNT-NETAAAAAAAAAA', {
        network: 'Mainnet',
      });
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockResolvedValueOnce(sessionTestnet)
        .mockResolvedValueOnce(sessionMainnet);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });
      expect(result.current.session?.network).toBe('Testnet');

      await act(async () => {
        await result.current.connect('freighter');
      });

      // Documented contract: a network label change does not disconnect the
      // wallet; the new session replaces the previous one.
      expect(result.current.status).toBe('connected');
      expect(result.current.session?.network).toBe('Mainnet');
      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify(sessionMainnet),
      );
    });

    it('persists reconnect sessions with unrecognized network labels unchanged', async () => {
      const sessionFuturenet = makeSession('GACCOUNT-NETBBBBBBBBBB', {
        network: 'Futurenet',
      });
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValueOnce(sessionFuturenet);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.session?.network).toBe('Futurenet');
      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify(sessionFuturenet),
      );
    });
  });

  describe('disconnect cleanup', () => {
    it('ignores a pending signer lookup that resolves after disconnect', async () => {
      const deferred = createDeferred<MultisigAccount>();
      vi.mocked(fetchMultisigAccount).mockReturnValue(deferred.promise);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.multisig.status).toBe('loading');
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      // A resumption of the stale lookup must not resurrect cleared state.
      await act(async () => {
        deferred.resolve(makeAccount(mockSession.publicKey));
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(result.current.multisig).toMatchObject({
        status: 'idle',
        account: null,
      });
    });
    
    it('is idempotent when invoked repeatedly', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      act(() => {
        result.current.disconnect();
        result.current.disconnect();
        result.current.disconnect();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(result.current.selectedWalletId).toBeNull();
      expect(result.current.errorMessage).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('cancels a pending signer lookup that rejects after unmount', async () => {
      const deferred = createDeferred<MultisigAccount>();
      vi.mocked(fetchMultisigAccount).mockReturnValue(deferred.promise);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result, unmount } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('loading');
      });

      unmount();
      
      // Reject after unmount: the provider attaches a catch handler, so no
      // unhandled rejection may escape and no state update may fire.
      await act(async () => {
        deferred.reject(new Error('late horizon failure'));
      });

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('dependency failures', () => {
    it('surfaces a non-Error signer lookup failure with the fallback message', async () => {
      vi
        .mocked(fetchMultisigAccount)
        .mockRejectedValueOnce({ code: 'HORIZON_500' });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.multisig.status).toBe('error');
      });
      expect(result.current.multisig.error).toBe(FALLBACK_HORIZON_MESSAGE);
      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
    });

    it('routes connection failures through toWalletErrorMessage', async () => {
      const failure = new Error('popup was closed by the user');
      const { connectWallet, toWalletErrorMessage } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockRejectedValueOnce(failure);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(vi.mocked(toWalletErrorMessage)).toHaveBeenCalled();
      expect(vi.mocked(toWalletErrorMessage)).toHaveBeenCalledWith(failure);
      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toBeDefined();
    });

    it('recovers from a failed connect on a subsequent successful connect', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet)
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValueOnce(makeSession('GACCOUNT-RECOVERAAAAAA'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });
      expect(result.current.status).toBe('error');

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session?.publicKey).toBe('GACCOUNT-RECOVERAAAAAA');
      expect(result.current.errorMessage).toBeNull();
    });
  });

  describe('clearError', () => {
    it('clears the error message and returns to idle when in error state', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockRejectedValueOnce(new Error('boom'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await act(async () => {
        await result.current.connect('freighter');
      });
      expect(result.current.status).toBe('error');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.errorMessage).toBeNull();
      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('does not disturb an active connection', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValueOnce(mockSession);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await act(async () => {
        await result.current.connect('freighter');
      });

      act(() => {
        result.current.clearError();
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.errorMessage).toBeNull();
    });
  });

  describe('effect subscription lifecycle', () => {
    it('re-renders do not duplicate the signer lookup subscription', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result, rerender } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      // Re-renders after state settles must not re-read signer information:
      // the effect is keyed on the connected public key, not on every render.
      rerender();

      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenCalledWith(
        mockSession.publicKey,
      );
    });
  });

  describe('refreshMultisigAccount', () => {
    it('re-reads signer information bypassing the cache and updates state', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });
      const initialCalls = vi.mocked(fetchMultisigAccount).mock.calls.length;

      await act(async () => {
        await result.current.refreshMultisigAccount();
      });

      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenCalledTimes(
        initialCalls + 1,
      );
      expect(vi.mocked(fetchMultisigAccount)).toHaveBeenLastCalledWith(
        mockSession.publicKey,
        { bypassCache: true },
      );
      expect(result.current.multisig.status).toBe('ready');
    });

    it('surfaces failure as multisig error state without dropping the session', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      vi
        .mocked(fetchMultisigAccount)
        .mockRejectedValueOnce(new Error('refresh failed'));

      await act(async () => {
        await result.current.refreshMultisigAccount();
      });

      expect(result.current.multisig.status).toBe('error');
      expect(result.current.multisig.error).toBe('refresh failed');
      expect(result.current.multisig.account).not.toBeNull();
      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
    });

    it('surfaces a non-Error refresh failure with the fallback message', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.multisig.status).toBe('ready');
      });

      vi.mocked(fetchMultisigAccount).mockRejectedValueOnce(
        'refresh exploded',
      );

      await act(async () => {
        await result.current.refreshMultisigAccount();
      });

      expect(result.current.multisig.status).toBe('error');
      expect(result.current.multisig.error).toBe(FALLBACK_HORIZON_MESSAGE);
    });

    it('is a no-op when no wallet is connected', async () => {
      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      await act(async () => {
        await result.current.refreshMultisigAccount();
      });

      expect(vi.mocked(fetchMultisigAccount)).not.toHaveBeenCalled();
      expect(result.current.multisig.status).toBe('idle');
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
