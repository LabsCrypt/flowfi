import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { xdr, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, "..", ".e2e-certs");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const KEY_PATH = path.join(CERT_DIR, "key.pem");

const PORT = Number(process.env.MOCK_API_PORT || 3100);
const RPC_PORT = Number(process.env.MOCK_RPC_PORT || 3102);
const APP_ORIGIN = process.env.E2E_APP_ORIGIN || "http://localhost:3101";
const SESSION_PUBLIC_KEY = "GB5P5GY25PGHPN4DG2XSQLWCUHTFUK2GDZ75IWB7KZV3RKBVH33GZ32U";

const RECIPIENT_PUBLIC_KEY = "GDBX55OJUOXRSTWICUESBZAHSMJNFWZ57NEEPVN74BXKH7OGZV23RYCG";
const USDC_ADDRESS = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const RATE_PER_SECOND = "10000000"; // 1 USDC / second (7 decimals)
const DEPOSITED_AMOUNT = "100000000000"; // 10,000 USDC
const WITHDRAW_BATCH = BigInt("100000000"); // 10 USDC per simulated withdrawal

const accountSequence = ["1"];

const nowSec = () => Math.floor(Date.now() / 1000);

function createStream() {
  return {
    id: "42",
    streamId: 42,
    sender: SESSION_PUBLIC_KEY,
    recipient: RECIPIENT_PUBLIC_KEY,
    tokenAddress: USDC_ADDRESS,
    ratePerSecond: RATE_PER_SECOND,
    depositedAmount: DEPOSITED_AMOUNT,
    withdrawnAmount: "0",
    startTime: nowSec() - 15,
    lastUpdateTime: nowSec() - 3,
    endTime: null,
    isActive: true,
    isPaused: false,
    status: "active",
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let stream = createStream();
const watchers = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of watchers) {
    try {
      res.write(payload);
    } catch {
      watchers.delete(res);
    }
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

const sendJson = (res, statusCode, body, extraHeaders = {}) => {
  const headers = { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

// ── XDR factories ────────────────────────────────────────────────────────────

function accountEntryXdr(publicKey, seq) {
  const kp = Keypair.fromPublicKey(publicKey);
  const accountEntry = new xdr.AccountEntry({
    accountId: kp.xdrAccountId(),
    balance: xdr.Int64.fromString("0"),
    seqNum: new xdr.SequenceNumber(xdr.Int64.fromString(String(seq))),
    numSubEntries: 0,
    flags: 0,
    homeDomain: "",
    thresholds: new Uint8Array(4),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
  return xdr.LedgerEntryData.account(accountEntry);
}

function ledgerKeyXdr(publicKey) {
  const kp = Keypair.fromPublicKey(publicKey);
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrPublicKey() }));
}

function sorobanTransactionDataBase64() {
  const footprint = new xdr.LedgerFootprint({ readOnly: [], readWrite: [] });
  const resources = new xdr.SorobanResources({
    footprint,
    instructions: 0,
    diskReadBytes: 8,
    writeBytes: 8,
  });
  const data = new xdr.SorobanTransactionData({
    resources,
    resourceFee: 0n,
    ext: new xdr.SorobanTransactionDataExt(0),
  });
  return data.toXDR("base64");
}

function scValVoidBase64() {
  return xdr.ScVal.scvVoid().toXDR("base64");
}

// ── REST / SSE handlers ──────────────────────────────────────────────────────

function buildEvents() {
  const events = [
    {
      id: "1",
      streamId: 42,
      eventType: "CREATED",
      timestamp: nowSec() - 3600,
      amount: DEPOSITED_AMOUNT,
    },
  ];
  if (Number(stream.withdrawnAmount) > 0) {
    events.push({
      id: "2",
      streamId: 42,
      eventType: "WITHDRAWN",
      timestamp: nowSec(),
      amount: stream.withdrawnAmount,
    });
  }
  return events;
}

function handleRest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/v1/streams" || url.pathname === "/api/v1/streams")
  ) {
    return sendJson(res, 200, { data: [stream] });
  }

  const streamDetail = url.pathname.match(/^\/v1\/streams\/(\d+)$/);
  if (req.method === "GET" && streamDetail) {
    return sendJson(res, 200, stream);
  }

  const streamEvents = url.pathname.match(/^\/v1\/streams\/(\d+)\/events$/);
  if (req.method === "GET" && streamEvents) {
    const all = buildEvents();
    return sendJson(res, 200, {
      events: all,
      total: all.length,
      page: Number(url.searchParams.get("page") || 1),
      limit: Number(url.searchParams.get("limit") || 20),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/events/subscribe") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": APP_ORIGIN,
    });
    res.write(`retry: 3000\n\n`);
    watchers.add(res);
    req.on("close", () => watchers.delete(res));
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    res.on("close", () => clearInterval(heartbeat));
    return;
  }

  const withdrawControl = url.pathname.match(/^\/__e2e\/stream\/(\d+)\/withdraw$/);
  if (req.method === "POST" && withdrawControl) {
    const current = Number(stream.withdrawnAmount) || 0;
    stream = {
      ...stream,
      withdrawnAmount: (current + Number(WITHDRAW_BATCH)).toString(),
      updatedAt: new Date().toISOString(),
      lastUpdateTime: nowSec(),
    };
    broadcast("stream.withdrawn", { streamId: 42 });
    return sendJson(res, 200, { ok: true, withdrawnAmount: stream.withdrawnAmount });
  }

  return sendJson(res, 404, { error: "not found" });
}

// ── Soroban RPC handlers ─────────────────────────────────────────────────────

function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

let submittedTransactionXdr = null;

function successTxResultBase64() {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("0"),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  }).toXDR("base64");
}

function zeroTxMetaBase64() {
  return new xdr.TransactionMeta(0, []).toXDR("base64");
}

function dummyEnvelopeBase64() {
  return new TransactionBuilder(
    Keypair.fromPublicKey(SESSION_PUBLIC_KEY),
    { fee: "1", networkPassphrase: Networks.TESTNET },
  )
    .setTimeout(30)
    .build()
    .toXDR("base64");
}

async function handleRpc(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end(rpcError(null, -32600, "method not allowed"));
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "invalid json" }));
  }

  const { id, method, params } = body;

  try {
    switch (method) {
      case "getHealth":
        return res.end(rpcResult(id, { status: "healthy" }));

      case "getNetwork":
        return res.end(
          rpcResult(id, {
            friendbotUrl: "https://friendbot-futurenet.stellar.org/",
            passthroughUrls: {},
            sorobanRpcUrl: "",
          }),
        );

      case "getLatestLedger":
        return res.end(
          rpcResult(id, {
            id: "0000000000000000000000000000000000000000000000000000000000000000",
            protocolVersion: 22,
            sequence: 1000,
          }),
        );

      case "getLedgerEntries": {
        const keys = Array.isArray(params?.keys) ? params.keys : [];
        const entries = keys.length
          ? keys.map((keyBase64) => ({
              key: keyBase64,
              xdr: accountEntryXdr(SESSION_PUBLIC_KEY, 1).toXDR("base64"),
              lastModifiedLedgerSeq: 0,
            }))
          : [];
        return res.end(rpcResult(id, { latestLedger: 1000, entries }));
      }

      case "simulateTransaction":
        return res.end(
          rpcResult(id, {
            id: "sim-1",
            latestLedger: 1000,
            transactionData: sorobanTransactionDataBase64(),
            minResourceFee: "0",
            cost: { cpuInsns: "0", memBytes: "0" },
            results: [{ auth: [], xdr: scValVoidBase64() }],
            events: [],
          }),
        );

      case "sendTransaction":
        submittedTransactionXdr = params?.transaction ?? null;
        return res.end(
          rpcResult(id, {
            status: "PENDING",
            hash: "0000000000000000000000000000000000000000000000000000000000000000",
            latestLedger: 1000,
            latestLedgerCloseTime: 0,
          }),
        );

      case "getTransaction":
        return res.end(
          rpcResult(id, {
            status: "SUCCESS",
            latestLedger: 1000,
            latestLedgerCloseTime: 0,
            ledger: 1000,
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr:
              submittedTransactionXdr ?? dummyEnvelopeBase64(),
            resultXdr: successTxResultBase64(),
            resultMetaXdr: zeroTxMetaBase64(),
          }),
        );

      default:
        return res.end(rpcError(id, -32601, `method not found: ${method}`));
    }
  } catch (err) {
    res.end(rpcError(id, -32603, err.message));
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const server = http.createServer(handleRest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock-api] rest+sse listening on http://localhost:${PORT}`);
});

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error("[mock-api] missing TLS certs — run the pw global-setup first (playwright install)");
  process.exit(1);
}

const rpcServer = https.createServer(
  { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) },
  handleRpc,
);
rpcServer.listen(RPC_PORT, "0.0.0.0", () => {
  console.log(`[mock-api] soroban rpc listening on https://localhost:${RPC_PORT}`);
});