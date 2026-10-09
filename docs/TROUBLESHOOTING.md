# FlowFi Troubleshooting & FAQ

Common setup hurdles for new contributors and users. If your problem isn't
covered here, open a
[GitHub Discussion](https://github.com/LabsCrypt/flowfi/discussions) with the
exact error text, your network (Testnet / Futurenet / Mainnet), and the steps
you took.

- [Freighter wallet](#freighter-wallet)
- [Funding test accounts (Friendbot)](#funding-test-accounts-with-friendbot)
- [Soroban RPC errors](#soroban-rpc-errors)
- [Network passphrase errors](#network-passphrase-errors)
- [Still stuck?](#still-stuck)

---

## Freighter wallet

### Install and connect

1. Install the [Freighter extension](https://www.freighter.app/) for your
   browser and create (or import) a wallet.
2. Open the FlowFi app and click **Connect Wallet**.
3. Approve the connection request in the Freighter popup. If no popup appears,
   click the Freighter icon in your toolbar — the request may be waiting there.
4. Freighter returns your **public key** (`G...`). FlowFi never asks for your
   secret key; signing happens inside the extension.

> **Nothing happens after clicking "Connect Wallet"?**
> Hard-refresh the page (`Cmd/Ctrl + Shift + R`) and make sure the extension is
> unlocked. Locked wallets silently reject connection requests.

### Switch Freighter to Testnet / Futurenet

Freighter defaults to **Mainnet** on install. FlowFi development flows expect
**Testnet** (or **Futurenet** for pre-release features).

1. Click the Freighter icon in your browser toolbar.
2. Click the **network selector** at the top-left of the popup (it shows
   `Mainnet` by default).
3. Choose **Testnet** or **Futurenet** from the list.
4. Return to the FlowFi tab and refresh.

The dashboard header shows a network chip (e.g. `Testnet`) next to your
address:

- **Mismatch warning** — the chip is highlighted when the connected network is
  not the one FlowFi expects. Switch Freighter, then refresh.
- **Mainnet badge** — shown when you're on Mainnet. Creating streams on Mainnet
  spends real XLM/tokens, so double-check before signing.

### "Transaction failed" / signature rejected

- Confirm the wallet address matches the account you funded (see below).
- Confirm Freighter is on the same network as the app.
- Make sure the account has enough XLM to cover the base fee and any Soroban
  resource fee.

### Reset a stuck connection

1. Open Freighter → **Settings** → **Connected apps**.
2. Remove FlowFi, then reconnect from the FlowFi app.

---

## Funding test accounts with Friendbot

Testnet and Futurenet accounts need a starting balance before they can pay
transaction fees. **Friendbot** funds them for free.

### Option A — Browser

1. Copy your public key (`G...`) from Freighter or the dashboard header.
2. Open the Friendbot for your network:
   - Testnet: <https://friendbot.stellar.org>
   - Futurenet: <https://friendbot-futurenet.stellar.org>
3. Paste the public key and click **Get lumens**.

### Option B — `curl`

```bash
# Testnet
curl "https://friendbot.stellar.org?addr=G...YOUR_PUBLIC_KEY"

# Futurenet
curl "https://friendbot-futurenet.stellar.org?addr=G...YOUR_PUBLIC_KEY"
```

A successful response is a JSON object containing a transaction hash.

### Option C — Stellar CLI

```bash
stellar keys generate --global flowfi-dev --network testnet --fund
stellar keys address flowfi-dev   # prints the funded G... address
```

### FAQ

- **"createAccountAlreadyExist" / "account already funded"** — Friendbot only
  funds an account once. If you need more test XLM, create a second identity or
  request from a faucet.
- **"op_underfunded" when creating a stream** — the account was never funded, or
  the amount exceeds the balance. Re-run Friendbot and retry.
- **Funded the wrong account?** — Friendbot funds the exact `G...` key you
  paste. Copy the address from the same wallet you connected to FlowFi.

---

## Soroban RPC errors

FlowFi talks to a Soroban RPC endpoint (default:
`https://soroban-testnet.stellar.org`). Public endpoints are shared and
rate-limited.

### `rate limit exceeded` / HTTP 429

The RPC provider is throttling your IP.

1. Wait a few seconds and retry — FlowFi already backs off on transient
   failures.
2. Reduce request volume: avoid rapid refresh loops and close unused dashboard
   tabs.
3. Run your own RPC node or point the app at a dedicated provider. Set the RPC
   URL via the backend/frontend environment:

   ```bash
   # .env
   SOROBAN_RPC_URL=https://your-dedicated-soroban-rpc.example.com
   ```

### `simulation timeout` / `Request timeout` / `ETIMEDOUT`

Simulation builds the transaction footprint by executing the contract against a
recent ledger. Slow or overloaded endpoints time out.

1. Retry once — timeouts are often transient.
2. Confirm the endpoint is reachable:

   ```bash
   curl -s https://soroban-testnet.stellar.org/health
   ```

3. Verify the network matches your wallet. Simulating a Testnet contract on
   Mainnet (or vice-versa) hangs or fails.
4. If the timeout persists, switch to a dedicated RPC provider as above.

### `contract not found` / `HostError`

- The contract ID in your config is wrong, or the contract is deployed on a
  different network than the one you're simulating against.
- Re-run the deployment script and confirm `deployment-info.json` lists the
  contract for the network you're using:

  ```bash
  ./scripts/deploy.sh --network testnet
  ```

### `tx_bad_seq` / stale sequence number

A previously submitted transaction is still pending. Wait for it to confirm (or
time out) and retry; FlowFi re-fetches the account sequence before each
submission.

---

## Network passphrase errors

The network passphrase is hashed into every transaction signature. A malformed
passphrase (a stray space, a missing semicolon) produces a confusing
"signature / hash mismatch" error at submission time.

The TypeScript SDK validates the passphrase in the `FlowFiClient` constructor
and throws an actionable message:

```text
FlowFiClient: Unrecognised network passphrase: "Test SDF Network;September 2015".
FlowFi expects an official Stellar passphrase (mind the spaces around ";", it is case-sensitive):
  • Public Global Stellar Network ; September 2015
  • Test SDF Network ; September 2015
  • Test SDF Future Network ; October 2022
  • Standalone Network ; February 2017
Did you mean: "Test SDF Network ; September 2015"?
```

Use an official passphrase exactly as shown above:

| Network    | Passphrase                                   |
| ---------- | -------------------------------------------- |
| Public     | `Public Global Stellar Network ; September 2015` |
| Testnet    | `Test SDF Network ; September 2015`          |
| Futurenet  | `Test SDF Future Network ; October 2022`     |
| Standalone | `Standalone Network ; February 2017`         |

Running an intentional private/custom network? Opt out explicitly:

```ts
new FlowFiClient({
  rpcUrl: 'https://my-private-soroban.example.com',
  networkPassphrase: 'My Private Network ; 2026',
  contractId: 'C...',
  allowCustomNetworkPassphrase: true,
});
```

---

## Still stuck?

1. Re-check prerequisites in the [Development Guide](DEVELOPMENT.md).
2. Search existing [GitHub Discussions](https://github.com/LabsCrypt/flowfi/discussions).
3. Open a new discussion including:
   - the exact error message,
   - your network,
   - the steps to reproduce,
   - relevant logs (redact any secret keys!).
