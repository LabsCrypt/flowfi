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
import { type WalletId } from "@/lib/wallet";
import { useWallet } from "@/context/wallet-context";
import { useModalDialog } from "@/hooks/useModalDialog";

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
    clearError,
  } = useWallet();

  const isConnecting = status === "connecting";
  const [freighterInstalled, setFreighterInstalled] = React.useState(true);

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
