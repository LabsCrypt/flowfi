"use client";

import { useWallet } from "@/context/wallet-context";
import { type WalletDescriptor } from "@/lib/wallet";
import { useEffect } from "react";

interface WalletSelectionModalProps {
  isOpen: boolean;
  onClose?: () => void;
}

interface WalletCardProps {
  wallet: WalletDescriptor;
  isConnecting: boolean;
  isActive: boolean;
  onConnect: () => void;
  index: number;
}

function WalletCard({
  wallet,
  isConnecting,
  isActive,
  onConnect,
  index,
}: WalletCardProps) {
  return (
    <article
      className="wallet-selection-card"
      data-active={isActive ? "true" : undefined}
      data-connecting={isConnecting ? "true" : undefined}
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <header className="wallet-selection-card__header">
        <div className="wallet-selection-card__info">
          <h3 className="wallet-selection-card__name">{wallet.name}</h3>
          <span className="wallet-selection-card__badge">{wallet.badge}</span>
        </div>
        {isConnecting && (
          <div className="wallet-selection-card__spinner" aria-label="Connecting">
            <div className="spinner-small"></div>
          </div>
        )}
      </header>
      <p className="wallet-selection-card__description">{wallet.description}</p>
      <button
        type="button"
        className="wallet-selection-card__button"
        disabled={isConnecting}
        onClick={onConnect}
        aria-busy={isConnecting}
      >
        {isConnecting ? (
          <>
            <span className="wallet-selection-card__button-text">
              Connecting...
            </span>
          </>
        ) : (
          <span className="wallet-selection-card__button-text">
            Connect {wallet.name}
          </span>
        )}
      </button>
    </article>
  );
}

export function WalletSelectionModal({
  isOpen,
  onClose,
}: WalletSelectionModalProps) {
  const {
    wallets,
    status,
    selectedWalletId,
    errorMessage,
    connect,
    clearError,
  } = useWallet();

  const isConnecting = status === "connecting";

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        isOpen &&
        !isConnecting &&
        onClose
      ) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, isConnecting, onClose, status]);

  if (!isOpen) {
    return null;
  }

  const handleWalletConnect = async (walletId: string) => {
    clearError();
    await connect(walletId as "freighter" | "albedo" | "xbull");
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !isConnecting && onClose) {
      onClose();
    }
  };

  return (
    <div
      className="wallet-selection-modal-overlay"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-selection-title"
    >
      <div className="wallet-selection-modal">
        <div className="wallet-selection-modal__header">
          <div>
            <p className="wallet-selection-modal__kicker">Connect Wallet</p>
            <h2 id="wallet-selection-title" className="wallet-selection-modal__title">
              Select a wallet to continue
            </h2>
            <p className="wallet-selection-modal__subtitle">
              Choose your preferred wallet provider to connect to FlowFi. Your
              connection will be securely stored locally.
            </p>
          </div>
          {onClose && !isConnecting && (
            <button
              type="button"
              className="wallet-selection-modal__close"
              onClick={onClose}
              aria-label="Close wallet selection"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M15 5L5 15M5 5L15 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        {errorMessage && (
          <div className="wallet-selection-modal__error" role="alert">
            <div className="wallet-selection-modal__error-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M10 6V10M10 14H10.01M19 10C19 14.9706 14.9706 19 10 19C5.02944 19 1 14.9706 1 10C1 5.02944 5.02944 1 10 1C14.9706 1 19 5.02944 19 10Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="wallet-selection-modal__error-content">
              <strong className="wallet-selection-modal__error-title">
                Connection Failed
              </strong>
              <p className="wallet-selection-modal__error-message">
                {errorMessage}
              </p>
            </div>
            <button
              type="button"
              className="wallet-selection-modal__error-dismiss"
              onClick={clearError}
              aria-label="Dismiss error"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M12 4L4 12M4 4L12 12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        <div className="wallet-selection-modal__content">
          <div className="wallet-selection-grid">
            {wallets.map((wallet, index) => {
              const isActive = selectedWalletId === wallet.id;
              const isConnectingThisWallet = isConnecting && isActive;

              return (
                <WalletCard
                  key={wallet.id}
                  wallet={wallet}
                  isConnecting={isConnectingThisWallet}
                  isActive={isActive}
                  onConnect={() => void handleWalletConnect(wallet.id)}
                  index={index}
                />
              );
            })}
          </div>
        </div>

        <div className="wallet-selection-modal__footer">
          <p
            className="wallet-selection-modal__status"
            data-busy={isConnecting ? "true" : undefined}
          >
            {isConnecting
              ? "Awaiting wallet approval. Please confirm the connection in your wallet."
              : "Supported wallets: Freighter, Albedo, xBull"}
          </p>
        </div>
      </div>
    </div>
  );
}
