---
title: TypeScript SDK
---

# TypeScript SDK (`@flowfi/sdk`)

```bash
npm install @flowfi/sdk
```

```ts
import { FlowFiClient } from "@flowfi/sdk";

const client = new FlowFiClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CDLZ...CONTRACT",
});

// Create a linear stream
const streamId = await client.createStream({
  sender: keypair,
  recipient: "GBRB...",
  token: "CDLZ...TOKEN",
  amountStroops: 1_000_000_000n,
  durationSeconds: 86_400,
});

// Read state
const claimable = await client.getClaimableAmount(streamId);
const stream = await client.getStream(streamId);

// Withdraw (recipient's keypair)
await client.withdraw({ recipient: keypair, streamId });

// Conditional milestones (#1482)
await client.verifyAndUnlockMilestone({ caller: keypair, streamId, milestoneId: 1 });
```

All amounts are `bigint` stroops. Methods map 1:1 onto the contract
entrypoints; see the [Rust reference](/contracts/soroban-reference) for
the on-chain semantics and error codes.
