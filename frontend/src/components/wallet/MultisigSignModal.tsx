"use client";

/**
 * components/wallet/MultisigSignModal.tsx
 *
 * Multisig Transaction Coordinator (issue #1471).
 *
 * Shown when the connected wallet's single signature is below the account's
 * required signing weight. It lets the user:
 *
 *  - see how much signature weight the partial envelope has collected,
 *  - copy the raw XDR / base64 envelope for Stellar Laboratory, LOBSTR Vault, …,
 *  - scan or open a SEP-0007 deep link in a mobile signer wallet,
 *  - append the connected wallet's signature, and import a co-signer's updated
 *    envelope, and
 *  - broadcast the finalized envelope once the threshold is met.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";
import { copyToClipboard } from "@/lib/clipboard";
import { logger } from "@/lib/logger";
import {
  buildQrCodeUrl,
  buildSep0007TxUri,
  createProposal,
  downloadXdrFile,
  evaluateSignatureProgress,
  requiredWeightForLevel,
  saveProposal,
  signPartialTransaction,
  submitSignedTransaction,
  updateProposal,
  type MultisigAccount,
  type MultisigProposal,
  type SignatureProgress,
  type ThresholdLevel,
} from "@/lib/stellar-multisig";
import { SignerThresholdBadge } from "./SignerThresholdBadge";

interface MultisigSignModalProps {
  account: MultisigAccount;
  /** Partially signed envelope that triggered the co-signing flow. */
  initialXdr: string;
  level?: ThresholdLevel;
  description?: string;
  /** Notified whenever the working envelope changes. */
  onXdrChange?: (xdr: string) => void;
  /** Called after a fully-signed envelope confirms on-chain. */
  onSubmitted?: (txHash: string) => void;
  onClose: () => void;
}

export function MultisigSignModal({
  account,
  initialXdr,
  level = "high",
  description = "Multisig stream transaction",
  onXdrChange,
  onSubmitted,
  onClose,
}: MultisigSignModalProps) {
  const [xdr, setXdr] = useState(initialXdr);
  const [progress, setProgress] = useState<SignatureProgress | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [proposal, setProposal] = useState<MultisigProposal | null>(null);
  const [importValue, setImportValue] = useState("");

  const isBusy = isSigning || isSubmitting;
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isBusy });

  const requiredWeight = requiredWeightForLevel(account.thresholds, level);
  const sepUri = useMemo(
    () =>
      buildSep0007TxUri({
        xdr,
        networkPassphrase: account.networkPassphrase,
        msg: description,
        pubkey: account.publicKey,
      }),
    [account.networkPassphrase, account.publicKey, description, xdr],
  );
  const qrCodeUrl = useMemo(() => {
    try {
      return buildQrCodeUrl(sepUri);
    } catch {
      return null;
    }
  }, [sepUri]);

  const applyXdr = useCallback(
    (next: string) => {
      setXdr(next);
      onXdrChange?.(next);
    },
    [onXdrChange],
  );

  // Recompute collected signature weight whenever the envelope changes.
  useEffect(() => {
    let cancelled = false;
    evaluateSignatureProgress(xdr, account, account.networkPassphrase, level)
      .then((result) => {
        if (cancelled) return;
        setProgress(result);
        setProgressError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProgress(null);
        setProgressError(err instanceof Error ? err.message : "Could not read the envelope.");
      });
    return () => {
      cancelled = true;
    };
  }, [account, level, xdr]);

  const handleAddSignature = async () => {
    setError(null);
    setIsSigning(true);
    try {
      const signed = await signPartialTransaction(xdr, account.networkPassphrase);
      applyXdr(signed);
      if (proposal) {
        setProposal(
          updateProposal(proposal.id, {
            xdr: signed,
            signedSigners: [...proposal.signedSigners, account.publicKey],
          }),
        );
      }
    } catch (err) {
      logger.error("Multisig signing failed:", err);
      setError(err instanceof Error ? err.message : "The wallet did not sign the envelope.");
    } finally {
      setIsSigning(false);
    }
  };

  const handleSubmit = async () => {
    if (!progress?.isSatisfied) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const { txHash } = await submitSignedTransaction(
        xdr,
        account.networkPassphrase,
        account.rpcUrl,
      );
      if (proposal) {
        setProposal(updateProposal(proposal.id, { status: "submitted", xdr }));
      }
      onSubmitted?.(txHash);
    } catch (err) {
      logger.error("Multisig submission failed:", err);
      if (proposal) {
        setProposal(updateProposal(proposal.id, { status: "failed" }));
      }
      setError(err instanceof Error ? err.message : "Failed to submit the transaction.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveProposal = () => {
    if (proposal) {
      setProposal(updateProposal(proposal.id, { xdr }));
    } else {
      const created = createProposal({
        account: account.publicKey,
        xdr,
        networkPassphrase: account.networkPassphrase,
        level,
        description,
        createdBy: account.publicKey,
      });
      saveProposal(created);
      setProposal(created);
    }
  };

  const handleImport = () => {
    const trimmed = importValue.trim();
    if (!trimmed) return;
    applyXdr(trimmed);
    setImportValue("");
  };

  const isSatisfied = progress?.isSatisfied ?? false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="multisig-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative z-10 mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-glass-border p-8"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="multisig-modal-title" className="text-2xl font-bold">
              Collect co-signatures
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              This account needs {requiredWeight} signing weight. Share the partial envelope
              with your co-signers, then broadcast once the threshold is met.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="text-slate-400 transition-colors hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <SignerThresholdBadge
          account={account}
          level={level}
          collectedWeight={progress?.collectedWeight}
          signedSigners={progress?.signedSigners.map((signer) => signer.key)}
          className="mb-6 w-full"
        />

        {progressError && (
          <p className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400" role="alert">
            {progressError}
          </p>
        )}

        {error && (
          <p className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        {/* Envelope + SEP-0007 handoff */}
        <section className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Partially signed XDR</h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyToClipboard(xdr, { successMessage: "Transaction XDR copied" })}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Copy XDR
                </button>
                <button
                  type="button"
                  onClick={() => downloadXdrFile(xdr)}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Download .xdr
                </button>
              </div>
            </div>
            <code className="block max-h-28 overflow-y-auto break-all rounded-xl bg-slate-900/70 p-3 font-mono text-[11px] text-slate-300">
              {xdr}
            </code>
          </div>

          <div className="flex flex-col gap-4 rounded-2xl border border-glass-border bg-glass p-4 sm:flex-row sm:items-center">
            {qrCodeUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={qrCodeUrl}
                alt="QR code for the SEP-0007 signing request"
                width={132}
                height={132}
                className="mx-auto rounded-lg bg-white p-1 sm:mx-0"
              />
            )}
            <div className="flex-1 space-y-2 text-sm">
              <p className="font-medium text-slate-200">SEP-0007 deep link</p>
              <p className="text-xs text-slate-400">
                Scan with a mobile signer wallet or open the link directly to import the
                envelope and add a signature.
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  href={sepUri}
                  className="text-xs font-semibold text-accent hover:underline"
                  data-testid="sep0007-link"
                >
                  Open in wallet
                </a>
                <button
                  type="button"
                  onClick={() =>
                    void copyToClipboard(sepUri, { successMessage: "SEP-0007 link copied" })
                  }
                  className="text-xs font-semibold text-accent hover:underline"
                >
                  Copy link
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Co-signer envelope import */}
        <section className="mt-6 space-y-2">
          <label htmlFor="multisig-import-xdr" className="text-sm font-semibold text-slate-200">
            Import a co-signer envelope
          </label>
          <textarea
            id="multisig-import-xdr"
            value={importValue}
            onChange={(e) => setImportValue(e.target.value)}
            rows={2}
            placeholder="Paste the updated XDR returned by your co-signer…"
            className="w-full resize-none rounded-xl border border-slate-800 bg-slate-900/50 p-3 font-mono text-xs outline-none transition-colors focus:border-accent"
          />
          <Button variant="outline" size="sm" onClick={handleImport} disabled={isBusy || !importValue.trim()}>
            Import envelope
          </Button>
        </section>

        {/* Actions */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-glass-border pt-6">
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={handleSaveProposal} disabled={isBusy}>
              {proposal ? "Update proposal" : "Save proposal"}
            </Button>
            <Button variant="secondary" onClick={() => void handleAddSignature()} loading={isSigning} disabled={isBusy}>
              Add my signature
            </Button>
          </div>
          <Button onClick={() => void handleSubmit()} loading={isSubmitting} disabled={!isSatisfied || isBusy} glow={isSatisfied}>
            {isSatisfied ? "Broadcast transaction" : "Waiting for signatures"}
          </Button>
        </div>
      </div>
    </div>
  );
}
