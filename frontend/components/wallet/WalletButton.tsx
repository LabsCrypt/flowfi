"use client";

/**
 * components/wallet/WalletButton.tsx
 *
 * Top-level connect/disconnect control for the Navbar.
 *
 * - Disconnected: shows "Connect Wallet" button → opens WalletModal.
 * - Connecting: shows a loading chip.
 * - Connected: shows a compact wallet chip (wallet name + network + short key).
 *   Clicking opens a small dropdown with:
 *     - Full public key with "Copy" button
 *     - "Disconnect" button
 */

import React, { useState, useRef, useEffect } from "react";
import { useWallet } from "@/context/wallet-context";
import {
  formatNetwork,
  shortenPublicKey,
  isExpectedNetwork,
} from "@/lib/wallet";
import { WalletModal } from "./WalletModal";

export function WalletButton() {
  const { status, session, disconnect, isHydrated } = useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);



  const handleCopy = async () => {
    if (!session?.publicKey) return;
    try {
      await navigator.clipboard.writeText(session.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be blocked in some environments
    }
  };

  const handleDisconnect = () => {
    setDropdownOpen(false);
    setModalOpen(false);
    disconnect();
  };

  // Don't render anything until client-side hydration is complete to avoid
  // localStorage mismatch flicker.
  if (!isHydrated) {
    return (
      <div className="wallet-btn-skeleton" aria-hidden="true" />
    );
  }

  if (status === "connected" && session) {
    // const networkLabel = formatNetwork(session.network);
    const networkOk = isExpectedNetwork(session.network);

    return (
      <div className="wallet-chip-wrapper" ref={dropdownRef}>
        <button
          type="button"
          className="wallet-chip"
          aria-expanded={dropdownOpen}
          aria-haspopup="true"
          title={session.publicKey}
          onClick={() => setDropdownOpen((o) => !o)}
        >
          {/* <span className="wallet-chip__name">{session.walletName}</span> */}
          {/* <span
            className="wallet-chip__network"
            data-mainnet={networkLabel === "Mainnet" ? "true" : undefined}
            data-mismatch={!networkOk ? "true" : undefined}
          >
            {networkLabel}
          </span> */}
          <strong className="wallet-chip__key">
            {shortenPublicKey(session.publicKey)}
          </strong>
        </button>

        {dropdownOpen && (
          <div className="wallet-dropdown" role="menu">
            <div className="wallet-dropdown__key">
              <code title={session.publicKey}>
                {session.publicKey.slice(0, 20)}…
              </code>
              <button
                type="button"
                className="wallet-dropdown__copy"
                onClick={handleCopy}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>

            {!networkOk && (
              <p className="wallet-dropdown__warning">
                ⚠ Network mismatch — app expects{" "}
                {process.env.NEXT_PUBLIC_STELLAR_NETWORK === "MAINNET"
                  ? "Mainnet"
                  : "Testnet"}
                .
              </p>
            )}

            <button
              type="button"
              className="wallet-dropdown__disconnect"
              role="menuitem"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="wallet-btn-connecting" aria-busy="true">
        <span className="wallet-status-spinner" />
        Connecting…
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="wallet-connect-btn"
        onClick={() => setModalOpen(true)}
      >
        Connect Wallet
      </button>

      {modalOpen && (
        <WalletModal onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
