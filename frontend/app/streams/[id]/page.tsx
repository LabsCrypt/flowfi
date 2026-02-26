
import { notFound } from "next/navigation";
import LiveCounter from "@/components/LiveCounter";
import ProgressBar from "@/components/ProgressBar";


interface Transaction {
  id: string;
  date: string;
  amount: number;
  type: "withdrawal";
}

interface Stream {
  id: string;
  name: string;
  recipient: string;
  streamedAmount: number;
  totalAmount: number;
  transactions: Transaction[];
}

const MOCK_STREAMS: Record<string, Stream> = {
  "1": {
    id: "1",
    name: "Developer Grant — Q1",
    recipient: "0xAbC…1234",
    streamedAmount: 3200,
    totalAmount: 5000,
    transactions: [
      { id: "tx1", date: "2026-02-20", amount: 1000, type: "withdrawal" },
      { id: "tx2", date: "2026-02-18", amount: 1200, type: "withdrawal" },
      { id: "tx3", date: "2026-02-15", amount: 1000, type: "withdrawal" },
    ],
  },
  "2": {
    id: "2",
    name: "Marketing Budget Stream",
    recipient: "0xDeF…5678",
    streamedAmount: 800,
    totalAmount: 2000,
    transactions: [
      { id: "tx1", date: "2026-02-21", amount: 500, type: "withdrawal" },
      { id: "tx2", date: "2026-02-19", amount: 300, type: "withdrawal" },
    ],
  },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StreamDetailsPage({ params }: PageProps) {
  const { id } = await params;
  const stream = MOCK_STREAMS[id];

  if (!stream) notFound();

  const percentage = Math.round((stream.streamedAmount / stream.totalAmount) * 100);

  return (
    <main style={{ minHeight: "100vh", padding: "clamp(1rem, 3vw, 2rem)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: "1rem" }}>

        {/* Header */}
        <div>
          <p className="kicker">Stream #{stream.id}</p>
          <h1 style={{ margin: "0.4rem 0 0", fontSize: "clamp(1.6rem, 3vw, 2.2rem)", lineHeight: 1.1 }}>
            Stream Details
          </h1>
        </div>

        {/* Identity card */}
        <div className="dashboard-panel">
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.15rem" }}>{stream.name}</h2>
          <p style={{ margin: 0, color: "var(--text-muted)" }}>
            Recipient:{" "}
            <code
              style={{
                background: "rgba(19,38,61,0.07)",
                borderRadius: "0.4rem",
                padding: "0.15rem 0.45rem",
                fontSize: "0.85rem",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {stream.recipient}
            </code>
          </p>
        </div>

        {/* 1️⃣ Progress bar */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Streamed Progress</h3>
          </div>
          <ProgressBar
            percentage={percentage}
            label={`${stream.streamedAmount.toLocaleString()} / ${stream.totalAmount.toLocaleString()} tokens`}
          />
        </div>

        {/* 3️⃣ Live counter */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Live Balance</h3>
          </div>
          <LiveCounter initial={stream.streamedAmount} label="Accumulated balance" />
        </div>

        {/* 2️⃣ Transaction history */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Transaction History</h3>
            <span>{stream.transactions.length} withdrawals</span>
          </div>

          {stream.transactions.length === 0 ? (
            <div className="mini-empty-state">
              <p>No transactions yet.</p>
            </div>
          ) : (
            <ul className="activity-list">
              {stream.transactions.map((tx) => (
                <li key={tx.id} className="activity-item">
                  <div>
                    <strong>Withdrawal</strong>
                    <p>{tx.date}</p>
                  </div>
                  <span className="is-negative">
                    -{tx.amount.toLocaleString()} tokens
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

      </div>
    </main>
  );
}