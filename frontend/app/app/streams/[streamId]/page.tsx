"use client";

import Link from "next/link";
import React from "react";
import toast from "react-hot-toast";

import { TopUpModal } from "@/components/stream-creation/TopUpModal";
import { Button } from "@/components/ui/Button";
import { useWallet } from "@/context/wallet-context";
import type { BackendStream } from "@/lib/api-types";
import {
  topUpStream as sorobanTopUp,
  toBaseUnits,
  toSorobanErrorMessage,
} from "@/lib/soroban";
import { shortenPublicKey } from "@/lib/wallet";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/v1";
const TOKEN_DECIMALS = 1e7;

interface StreamDetailsPageProps {
  params: {
    streamId: string;
  };
}

function toDisplayAmount(baseUnits: string): number {
  const parsed = Number(baseUnits);
  if (!Number.isFinite(parsed)) return 0;
  return parsed / TOKEN_DECIMALS;
}

function formatUnixTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function inferTokenSymbol(tokenAddress: string): string {
  const known: Record<string, string | undefined> = {
    USDC: process.env.NEXT_PUBLIC_USDC_ADDRESS,
    XLM: process.env.NEXT_PUBLIC_XLM_ADDRESS,
    EURC: process.env.NEXT_PUBLIC_EURC_ADDRESS,
  };

  const normalized = tokenAddress.toUpperCase();
  for (const [symbol, address] of Object.entries(known)) {
    if (address && address.toUpperCase() === normalized) {
      return symbol;
    }
  }

  return "TOKEN";
}

export default function StreamDetailsPage({ params }: StreamDetailsPageProps) {
  const { session, status } = useWallet();

  const [stream, setStream] = React.useState<BackendStream | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showTopUpModal, setShowTopUpModal] = React.useState(false);

  const streamId = params.streamId;
  const isValidStreamId = /^\d+$/.test(streamId);

  const loadStream = React.useCallback(async () => {
    if (!isValidStreamId) {
      setError("Stream id must be numeric.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${API_BASE_URL}/streams/${streamId}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Stream not found.");
        }
        throw new Error(`Failed to load stream (${response.status}).`);
      }

      const data = (await response.json()) as BackendStream;
      setStream(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load stream.";
      setError(message);
      setStream(null);
    } finally {
      setLoading(false);
    }
  }, [isValidStreamId, streamId]);

  React.useEffect(() => {
    void loadStream();
  }, [loadStream]);

  const depositedAmount = stream ? toDisplayAmount(stream.depositedAmount) : 0;
  const withdrawnAmount = stream ? toDisplayAmount(stream.withdrawnAmount) : 0;
  const remainingAmount = Math.max(depositedAmount - withdrawnAmount, 0);
  const tokenSymbol = stream ? inferTokenSymbol(stream.tokenAddress) : "TOKEN";

  const isSender = Boolean(
    session && stream && session.publicKey === stream.sender,
  );
  const canTopUp =
    Boolean(stream?.isActive) &&
    status === "connected" &&
    Boolean(session) &&
    isSender;

  let topUpHelper = "";
  if (!stream?.isActive) {
    topUpHelper = "Only active streams can be topped up.";
  } else if (status !== "connected") {
    topUpHelper = "Connect your wallet to top up this stream.";
  } else if (!isSender) {
    topUpHelper = "Only the stream sender can top up this stream.";
  }

  const handleTopUpConfirm = async (_streamId: string, amount: string) => {
    if (!stream || !session) {
      throw new Error("Wallet is not connected.");
    }

    const toastId = toast.loading("Submitting top up transaction...");

    try {
      const amountInBaseUnits = toBaseUnits(amount);

      await sorobanTopUp(session, {
        streamId: BigInt(stream.streamId),
        amount: amountInBaseUnits,
      });

      setStream((previous) => {
        if (!previous) return previous;

        let nextDepositedAmount = previous.depositedAmount;
        try {
          nextDepositedAmount = (
            BigInt(previous.depositedAmount) + amountInBaseUnits
          ).toString();
        } catch {
          nextDepositedAmount = previous.depositedAmount;
        }

        return {
          ...previous,
          depositedAmount: nextDepositedAmount,
          lastUpdateTime: Math.floor(Date.now() / 1000),
        };
      });

      setShowTopUpModal(false);
      toast.success("Top up transaction submitted.", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  if (loading) {
    return (
      <main className="app-shell">
        <section className="wallet-panel wallet-panel--loading">
          <div className="loading-pulse" />
          <h1>Loading stream...</h1>
          <p className="subtitle">Fetching stream details and latest balances.</p>
        </section>
      </main>
    );
  }

  if (error || !stream) {
    return (
      <main className="app-shell">
        <section className="wallet-panel">
          <p className="kicker">Stream Details</p>
          <h1>Unable to load stream</h1>
          <p className="subtitle">{error ?? "The requested stream could not be loaded."}</p>
          <div className="flex gap-3">
            <Link href="/app" className="secondary-button inline-flex items-center">
              Back to Dashboard
            </Link>
            <Button onClick={() => void loadStream()}>Retry</Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard-main" style={{ gridColumn: "1 / -1" }}>
        <header className="dashboard-header">
          <div>
            <p className="kicker">Stream Details</p>
            <h1>Stream #{stream.streamId}</h1>
            <p className="subtitle" style={{ marginTop: "0.5rem" }}>
              Created {new Date(stream.createdAt).toLocaleString()}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/app" className="secondary-button inline-flex items-center">
              Back
            </Link>
            <Button
              onClick={() => setShowTopUpModal(true)}
              disabled={!canTopUp}
              glow={canTopUp}
            >
              Top Up Stream
            </Button>
          </div>
        </header>

        {topUpHelper ? <p className="dashboard-note">{topUpHelper}</p> : null}

        <section className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Overview</h3>
            <span>{stream.isActive ? "Active" : "Inactive"}</span>
          </div>

          <div className="dashboard-stats-grid">
            <div className="dashboard-stat-card">
              <p>Deposited</p>
              <h2>
                {depositedAmount.toFixed(2)} {tokenSymbol}
              </h2>
              <span>Total funded to the stream.</span>
            </div>
            <div className="dashboard-stat-card">
              <p>Withdrawn</p>
              <h2>
                {withdrawnAmount.toFixed(2)} {tokenSymbol}
              </h2>
              <span>Amount claimed by recipient.</span>
            </div>
            <div className="dashboard-stat-card">
              <p>Remaining</p>
              <h2>
                {remainingAmount.toFixed(2)} {tokenSymbol}
              </h2>
              <span>Estimated balance still in stream.</span>
            </div>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Participants</h3>
            <span>Sender and recipient wallets</span>
          </div>
          <div className="connected-meta">
            <div className="connected-row">
              <strong>Sender</strong>
              <code>{shortenPublicKey(stream.sender)}</code>
            </div>
            <div className="connected-row">
              <strong>Recipient</strong>
              <code>{shortenPublicKey(stream.recipient)}</code>
            </div>
            <div className="connected-row">
              <strong>Token Contract</strong>
              <code>{shortenPublicKey(stream.tokenAddress)}</code>
            </div>
            <div className="connected-row">
              <strong>Last Update</strong>
              <span>{formatUnixTimestamp(stream.lastUpdateTime)}</span>
            </div>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Indexed Events</h3>
            <span>{stream.events?.length ?? 0} events</span>
          </div>

          {!stream.events || stream.events.length === 0 ? (
            <div className="mini-empty-state">
              <p>No indexed events yet for this stream.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Ledger</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.events.map((event) => (
                    <tr key={event.id}>
                      <td>{event.eventType}</td>
                      <td>
                        {event.amount
                          ? `${toDisplayAmount(event.amount).toFixed(2)} ${tokenSymbol}`
                          : "-"}
                      </td>
                      <td>{event.ledgerSequence}</td>
                      <td>{formatUnixTimestamp(event.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>

      {showTopUpModal ? (
        <TopUpModal
          streamId={stream.streamId.toString()}
          token={tokenSymbol}
          currentDeposited={depositedAmount}
          onConfirm={handleTopUpConfirm}
          onClose={() => setShowTopUpModal(false)}
        />
      ) : null}
    </main>
  );
}
