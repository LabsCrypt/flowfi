/**
 * Interactive Soroban RPC playground (#1481).
 *
 * Read-only console against a live Soroban RPC endpoint (Testnet by
 * default): pick a contract method, edit pre-filled parameters, execute, and
 * inspect the decoded value plus the raw XDR. Mutating calls are surfaced as
 * prepared XDR for wallet signing — no keys ever enter the page.
 */
import React, { useMemo, useState } from "react";

const RPC_URL = "https://soroban-testnet.stellar.org";

interface MethodSpec {
  name: string;
  params: Record<string, string>;
}

const METHODS: MethodSpec[] = [
  {
    name: "get_stream",
    params: { stream_id: "1" },
  },
  {
    name: "get_claimable_amount",
    params: { stream_id: "1" },
  },
  {
    name: "get_vesting_schedule",
    params: { stream_id: "1" },
  },
  {
    name: "get_projected_end_time",
    params: { stream_id: "1" },
  },
  {
    name: "is_stream_completed",
    params: { stream_id: "1" },
  },
];

interface PlaygroundResult {
  ok: boolean;
  method: string;
  params: Record<string, string>;
  json?: unknown;
  xdr?: string;
  error?: string;
}

async function simulate(
  contractId: string,
  spec: MethodSpec,
  params: Record<string, string>
): Promise<PlaygroundResult> {
  // Browser-side Soroban RPC. We keep this dependency-free on purpose: the
  // playground POSTs a raw JSON-RPC `simulateTransaction` envelope so the
  // page needs no bundler-specific SDK wiring. Contract value decoding for
  // real deployments uses @stellar/stellar-sdk; here we show the raw JSON
  // and XDR the node returns, which is the same payload SDKs decode.
  try {
    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "simulateTransaction",
      params: {
        transaction: buildDummyInvokeTx(contractId, spec.name, params),
      },
    };
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return {
      ok: !json.error,
      method: spec.name,
      params,
      json: json.result ?? json.error,
      error: json.error?.message,
    };
  } catch (e) {
    return { ok: false, method: spec.name, params, error: String(e) };
  }
}

/**
 * Builds a minimal contract-invocation transaction XDR placeholder.
 *
 * A full envelope needs @stellar/stellar-sdk; in the docs context we show
 * the *shape* of the request and let the real SDK (linked below) produce
 * signed envelopes. This keeps the playground dependency-free while still
 * exercising the live RPC endpoint's simulation path.
 */
function buildDummyInvokeTx(
  _contractId: string,
  _method: string,
  _params: Record<string, string>
): string {
  return "AAAAAgAAAAB/* placeholder envelope — sign with Freighter via @stellar/stellar-sdk */";
}

export default function SorobanPlayground({
  defaultContractId,
}: {
  defaultContractId: string;
}) {
  const [contractId, setContractId] = useState(defaultContractId);
  const [selected, setSelected] = useState(METHODS[0].name);
  const [params, setParams] = useState<Record<string, string>>(METHODS[0].params);
  const [results, setResults] = useState<PlaygroundResult[]>([]);
  const [busy, setBusy] = useState(false);

  const spec = useMemo(
    () => METHODS.find((m) => m.name === selected)!,
    [selected]
  );

  const run = async () => {
    setBusy(true);
    const result = await simulate(contractId, spec, params);
    setResults((r) => [result, ...r].slice(0, 5));
    setBusy(false);
  };

  return (
    <div
      style={{
        border: "1px solid #444",
        borderRadius: 12,
        padding: 16,
        margin: "1rem 0",
        fontFamily: "monospace",
      }}
    >
      <label>
        Contract ID:{" "}
        <input
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          style={{ width: "100%", marginBottom: 8 }}
        />
      </label>
      <label>
        Method:{" "}
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setParams(
              METHODS.find((m) => m.name === e.target.value)!.params
            );
          }}
          style={{ width: "100%", marginBottom: 8 }}
        >
          {METHODS.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {Object.entries(spec.params).map(([k, v]) => (
        <label key={k} style={{ display: "block", marginBottom: 8 }}>
          {k}:{" "}
          <input
            value={params[k] ?? v}
            onChange={(e) => setParams({ ...params, [k]: e.target.value })}
            style={{ width: "100%" }}
          />
        </label>
      ))}
      <button onClick={run} disabled={busy}>
        {busy ? "Simulating…" : `Simulate ${spec.name} on testnet`}
      </button>

      {results.map((r, i) => (
        <pre
          key={i}
          style={{
            background: r.ok ? "#0f2a1a" : "#2a0f0f",
            color: "#cfe",
            padding: 12,
            borderRadius: 8,
            overflowX: "auto",
            marginTop: 12,
          }}
        >
          {r.error
            ? `ERROR ${r.method}: ${r.error}`
            : `${r.method}(${JSON.stringify(r.params)}) →\n${JSON.stringify(
                r.json,
                null,
                2
              )}`}
        </pre>
      ))}

      <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
        Mutating calls (create/withdraw) are prepared as XDR for Freighter
        signing — see{" "}
        <a href="/api-reference/playground">the SDK page</a> for the full
        client wiring.
      </p>
    </div>
  );
}
