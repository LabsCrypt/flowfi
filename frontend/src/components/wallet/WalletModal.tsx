"use client";

/**
 * components/wallet/WalletModal.tsx
 *
 * Wallet selection modal with connector availability and connection states.
 *
 * - Freighter: shows "Install Freighter" link when extension is absent.
 * - Dismiss via Escape key or backdrop click.
 *
 * Focus trapping, focus restoration, Escape handling and body-scroll locking
 * all come from the shared `useModalDialog` hook, so this dialog behaves the
 * same way as every other modal in the app.
 */

import React, { useEffect } from "react";
import { type WalletId, shortenPublicKey } from "@/lib/wallet";
import { useWallet } from "@/context/wallet-context";
import { useModalDialog } from "@/hooks/useModalDialog";
import {
  MOCK_MODE,
  fetchMockAccounts,
  type MockAccount,
} from "@/lib/mock-chain";

import { isConnected } from "@stellar/freighter-api";

interface WalletModalProps {
  onClose: () => void;
}

export function WalletModal({ onClose }: WalletModalProps) {
  const {
    wallets,
    status,
    selectedWalletId,
    errorMessage,
    connect,
    connectMock,
    clearError,
  } = useWallet();

  const isConnecting = status === "connecting";
  const [freighterInstalled, setFreighterInstalled] = React.useState(true);
  const [mockAccounts, setMockAccounts] = React.useState<MockAccount[]>([]);
  const [mockAccountsError, setMockAccountsError] = React.useState<string | null>(null);

  // Sandbox accounts come from the backend so the picker always lists exactly
  // the users the seed script created.
  const mockAccountsCancelled = React.useRef(false);

  useEffect(() => {
    if (!MOCK_MODE) return;

    const cancelled = mockAccountsCancelled;
    fetchMockAccounts()
      .then((accounts) => {
        if (!cancelled.current) setMockAccounts(accounts);
      })
      .catch((error: unknown) => {
        if (!cancelled.current) {
          setMockAccountsError(
            error instanceof Error ? error.message : "Could not load sandbox accounts.",
          );
        }
      });

    return () => {
      cancelled.current = true;
    };
  }, []);

  // Escape-to-close, focus trapping, focus restoration and body-scroll
  // locking. Closing stays disabled while a connection is in flight, matching
  // the disabled close button and the guarded backdrop click below.
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isConnecting });

  // The Freighter extension injects itself asynchronously.
  // We need to poll briefly after mount to reliably detect it.
  const cancelled = React.useRef(false);
  useEffect(() => {
    let attempts = 0;
    const interval = setInterval(async () => {
      const res = await isConnected();
      if (cancelled.current) return;
      if (res.isConnected) {
        setFreighterInstalled(true);
        clearInterval(interval);
      } else {
        attempts++;
        if (attempts >= 10) {
          setFreighterInstalled(false);
          clearInterval(interval);
        }
      }
    }, 100);

    return () => {
      cancelled.current = true;
      clearInterval(interval);
    };
  }, []);

  const handleConnect = async (walletId: WalletId) => {
    clearError();
    await connect(walletId);
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isConnecting) {
      onClose();
    }
  };

  return (
    <div
      className="wallet-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} className="wallet-modal">
        {/* Header */}
        <div className="wallet-modal__header">
          <div>
            <p className="kicker">FlowFi</p>
            <h2 id="wallet-modal-title">Connect a wallet</h2>
            <p className="subtitle">
              Choose your Stellar wallet. Your session is stored locally so you
              stay signed in after refresh.
            </p>
          </div>
          <button
            type="button"
            className="wallet-modal__close"
            aria-label="Close wallet modal"
            onClick={onClose}
            disabled={isConnecting}
          >
            ✕
          </button>
        </div>

        {/* Error banner */}
        {errorMessage && (
          <div className="wallet-error" role="alert">
            <span>{errorMessage}</span>
            <button type="button" className="inline-link" onClick={clearError}>
              Dismiss
            </button>
          </div>
        )}

        {/* Sandbox accounts — mock mode only */}
        {MOCK_MODE && (
          <section className="wallet-mock" aria-label="Sandbox accounts">
            <header className="wallet-mock__header">
              <p className="kicker">Mock sandbox</p>
              <h3>Sign in without a wallet</h3>
              <p>
                No wallet, no funding, no testnet. Pick one of the seeded demo
                accounts — every action is applied locally.
              </p>
            </header>

            {mockAccountsError && (
              <p className="wallet-error" role="alert">
                {mockAccountsError}
              </p>
            )}

            <div className="wallet-grid">
              {mockAccounts.map((account) => (
                <article key={account.publicKey} className="wallet-card">
                  <header className="wallet-card__header">
                    <h3>{account.label}</h3>
                    <span className="wallet-card__key">
                      {shortenPublicKey(account.publicKey)}
                    </span>
                  </header>
                  <p>Seeded demo account with 30 days of stream history.</p>
                  <button
                    type="button"
                    className="wallet-button"
                    disabled={isConnecting}
                    onClick={() => void connectMock(account.publicKey)}
                  >
                    {isConnecting ? "Signing in…" : `Continue as ${account.label}`}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Wallet cards */}
        <div className="wallet-grid">
          {wallets.map((wallet, index) => {
            const isActiveWallet = selectedWalletId === wallet.id;
            const isConnectingThis = isConnecting && isActiveWallet;
            const isFreighter = wallet.id === "freighter";
            const notInstalled = isFreighter && !freighterInstalled;
            return (
              <article
                key={wallet.id}
                className="wallet-card"
                data-active={isActiveWallet ? "true" : undefined}
                data-unavailable={notInstalled ? "true" : undefined}
                style={{ animationDelay: `${index * 110}ms` }}
              >
                <header className="wallet-card__header">
                  <h3>{wallet.name}</h3>
                  <span>{wallet.badge}</span>
                </header>
                <p>{wallet.description}</p>
                {notInstalled ? (
                  <a
                    href="https://freighter.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wallet-button wallet-button--install"
                  >
                    Install Freighter →
                  </a>
                ) : (
                  <button
                    type="button"
                    className="wallet-button"
                    disabled={isConnecting}
                    onClick={() => void handleConnect(wallet.id)}
                  >
                    {isConnectingThis ? (
                      <span className="wallet-button__spinner-row">
                        <span className="wallet-button__spinner" />
                        Awaiting approval…
                      </span>
                    ) : (
                      `Connect ${wallet.name}`
                    )}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        <p
          className="wallet-status"
          data-busy={isConnecting ? "true" : undefined}
        >
          {isConnecting
            ? "Waiting for wallet approval…"
            : `Supported wallets: ${wallets.map((wallet) => wallet.name).join(", ")}`}
        </p>
      </div>
    </div>
  );
}
