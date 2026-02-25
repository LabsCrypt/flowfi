"use client";

/**
 * components/wallet/WalletModal.tsx
 *
 * Wallet selection modal. Shows three wallet cards (Freighter, Albedo, xBull)
 * and handles all connecting states and error display.
 *
 * - Freighter: shows "Install Freighter" link when extension is absent.
 * - Albedo: note that a popup window will open.
 * - xBull: note for mobile / extension users.
 * - Dismiss via Escape key or backdrop click.
 */

import React, { useEffect, useCallback } from "react";
import { type WalletId } from "@/lib/wallet";
import { useWallet } from "@/context/wallet-context";

import { isConnected } from "@stellar/freighter-api";

interface WalletModalProps {
  onClose: () => void;
}

const WALLET_NOTES: Partial<Record<WalletId, string>> = {};

export function WalletModal({ onClose }: WalletModalProps) {
  const { wallets, status, selectedWalletId, errorMessage, connect, clearError } =
    useWallet();

  const isConnecting = status === "connecting";
  const [freighterInstalled, setFreighterInstalled] = React.useState(true);

  // The Freighter extension injects itself asynchronously.
  // We need to poll briefly after mount to reliably detect it.
  useEffect(() => {
    let attempts = 0;
    const interval = setInterval(async () => {
      const res = await isConnected();
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

    return () => clearInterval(interval);
  }, []);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isConnecting) {
        onClose();
      }
    },
    [isConnecting, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
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
      <div className="wallet-modal">
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
            <button
              type="button"
              className="inline-link"
              onClick={clearError}
            >
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
            const note = WALLET_NOTES[wallet.id];

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
                {note && !notInstalled && (
                  <p className="wallet-card__note">{note}</p>
                )}

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
            : "Freighter"}
        </p>
      </div>
    </div>
  );
}
