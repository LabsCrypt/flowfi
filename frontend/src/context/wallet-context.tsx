"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import {
  SUPPORTED_WALLETS,
  connectWallet,
  toWalletErrorMessage,
  type WalletDescriptor,
  type WalletId,
  type WalletSession,
} from "@/lib/wallet";
import { fetchMultisigAccount, type MultisigAccount } from "@/lib/stellar-multisig";

type WalletStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Signer/threshold information for the connected account (issue #1471).
 * Kept separate from the session so a failed Horizon lookup never breaks the
 * wallet connection itself.
 */
export interface MultisigState {
  status: "idle" | "loading" | "ready" | "error";
  account: MultisigAccount | null;
  error: string | null;
  isMultisig: boolean;
}

interface WalletContextValue {
  wallets: readonly WalletDescriptor[];
  status: WalletStatus;
  session: WalletSession | null;
  selectedWalletId: WalletId | null;
  errorMessage: string | null;
  isHydrated: boolean;
  connect: (walletId: WalletId) => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
  /** Multisig signer/threshold state for the connected account. */
  multisig: MultisigState;
  /** Re-reads signer information from Horizon, bypassing the cache. */
  refreshMultisigAccount: () => Promise<void>;
}

// STORAGE_KEY version should be bumped whenever WalletSession shape changes,
// so stale persisted sessions are discarded rather than causing type errors.
const STORAGE_KEY = "flowfi.wallet.session.v1";
const WalletContext = createContext<WalletContextValue | undefined>(undefined);
const VALID_WALLET_IDS = SUPPORTED_WALLETS.map((wallet) => wallet.id);

interface WalletState {
  status: WalletStatus;
  session: WalletSession | null;
  selectedWalletId: WalletId | null;
  errorMessage: string | null;
  isHydrated: boolean;
  multisig: MultisigState;
}

type WalletAction =
  | { type: "hydrate"; session: WalletSession | null }
  | { type: "connect:start"; walletId: WalletId }
  | { type: "connect:success"; session: WalletSession }
  | { type: "connect:error"; message: string }
  | { type: "disconnect" }
  | { type: "error:clear" }
  | { type: "multisig:start" }
  | { type: "multisig:success"; account: MultisigAccount }
  | { type: "multisig:error"; message: string }
  | { type: "multisig:reset" };

const INITIAL_MULTISIG_STATE: MultisigState = {
  status: "idle",
  account: null,
  error: null,
  isMultisig: false,
};

const INITIAL_STATE: WalletState = {
  status: "idle",
  session: null,
  selectedWalletId: null,
  errorMessage: null,
  isHydrated: false,
  multisig: INITIAL_MULTISIG_STATE,
};

function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "hydrate":
      if (!action.session) {
        return {
          ...state,
          isHydrated: true,
        };
      }

      return {
        status: "connected",
        session: action.session,
        selectedWalletId: action.session.walletId,
        errorMessage: null,
        isHydrated: true,
        multisig: INITIAL_MULTISIG_STATE,
      };
    case "connect:start":
      return {
        ...state,
        status: "connecting",
        selectedWalletId: action.walletId,
        errorMessage: null,
      };
    case "connect:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        selectedWalletId: action.session.walletId,
        errorMessage: null,
      };
    case "connect:error":
      return {
        ...state,
        status: "error",
        session: null,
        errorMessage: action.message,
        multisig: INITIAL_MULTISIG_STATE,
      };
    case "disconnect":
      return {
        ...state,
        status: "idle",
        session: null,
        selectedWalletId: null,
        errorMessage: null,
        multisig: INITIAL_MULTISIG_STATE,
      };
    case "error:clear":
      return {
        ...state,
        errorMessage: null,
        status: state.status === "error" ? "idle" : state.status,
      };
    case "multisig:start":
      return {
        ...state,
        multisig: { ...state.multisig, status: "loading", error: null },
      };
    case "multisig:success":
      return {
        ...state,
        multisig: {
          status: "ready",
          account: action.account,
          error: null,
          isMultisig: action.account.isMultisig,
        },
      };
    case "multisig:error":
      return {
        ...state,
        multisig: { ...state.multisig, status: "error", error: action.message },
      };
    case "multisig:reset":
      return { ...state, multisig: INITIAL_MULTISIG_STATE };
    default:
      return state;
  }
}

function isWalletSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Partial<WalletSession>;

  return (
    typeof session.walletId === "string" &&
    VALID_WALLET_IDS.includes(session.walletId as WalletId) &&
    typeof session.walletName === "string" &&
    typeof session.publicKey === "string" &&
    typeof session.connectedAt === "string" &&
    typeof session.network === "string" &&
    session.mocked === false
  );
}

function readStoredSession(): WalletSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isWalletSession(parsed)) {
      return parsed;
    }
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  return null;
}

function storeSession(session: WalletSession): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function removeStoredSession(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(walletReducer, INITIAL_STATE);

  useEffect(() => {
    const existingSession = readStoredSession();
    dispatch({ type: "hydrate", session: existingSession });
  }, []);

  const connectedPublicKey = state.session?.publicKey ?? null;

  // Detect multisig configuration whenever a wallet is connected (issue #1471).
  // This is best-effort: a Horizon failure only surfaces `multisig.error` and
  // leaves the wallet session untouched.
  useEffect(() => {
    if (!connectedPublicKey) {
      dispatch({ type: "multisig:reset" });
      return;
    }

    let cancelled = false;
    dispatch({ type: "multisig:start" });

    void fetchMultisigAccount(connectedPublicKey)
      .then((account) => {
        if (!cancelled) dispatch({ type: "multisig:success", account });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "multisig:error",
            message:
              error instanceof Error
                ? error.message
                : "Could not load signer information from Horizon.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectedPublicKey]);

  const refreshMultisigAccount = useCallback(async () => {
    if (!connectedPublicKey) return;
    dispatch({ type: "multisig:start" });
    try {
      const account = await fetchMultisigAccount(connectedPublicKey, {
        bypassCache: true,
      });
      dispatch({ type: "multisig:success", account });
    } catch (error) {
      dispatch({
        type: "multisig:error",
        message:
          error instanceof Error
            ? error.message
            : "Could not load signer information from Horizon.",
      });
    }
  }, [connectedPublicKey]);

  const clearError = useCallback(() => {
    dispatch({ type: "error:clear" });
  }, []);

  const connect = useCallback(async (walletId: WalletId) => {
    dispatch({ type: "connect:start", walletId });

    try {
      const nextSession = await connectWallet(walletId);
      dispatch({ type: "connect:success", session: nextSession });
      storeSession(nextSession);
    } catch (error) {
      dispatch({
        type: "connect:error",
        message: toWalletErrorMessage(error),
      });
      removeStoredSession();
    }
  }, []);

  const disconnect = useCallback(() => {
    dispatch({ type: "disconnect" });
    removeStoredSession();
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets: SUPPORTED_WALLETS,
      status: state.status,
      session: state.session,
      selectedWalletId: state.selectedWalletId,
      errorMessage: state.errorMessage,
      isHydrated: state.isHydrated,
      connect,
      disconnect,
      clearError,
      multisig: state.multisig,
      refreshMultisigAccount,
    }),
    [
      clearError,
      connect,
      disconnect,
      refreshMultisigAccount,
      state.errorMessage,
      state.isHydrated,
      state.multisig,
      state.selectedWalletId,
      state.session,
      state.status,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);

  if (!context) {
    throw new Error("useWallet must be used within WalletProvider.");
  }

  return context;
}
