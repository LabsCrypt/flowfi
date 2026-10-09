---
title: React (`@flowfi/react`)
---

# React (`@flowfi/react`)

Pre-bound hooks for dashboards built on `@tanstack/react-query`.

```tsx
import { FlowFiProvider, useStream, useClaimableAmount } from "@flowfi/react";

function App() {
  return (
    <FlowFiProvider rpcUrl="https://soroban-testnet.stellar.org"
                     contractId="CDLZ...CONTRACT">
      <StreamCard streamId={1n} />
    </FlowFiProvider>
  );
}

function StreamCard({ streamId }: { streamId: bigint }) {
  const { data: stream, isLoading } = useStream(streamId);
  const { data: claimable } = useClaimableAmount(streamId, { refetchInterval: 15_000 });

  if (isLoading) return <Skeleton />;
  return (
    <div>
      <h3>Stream #{streamId.toString()}</h3>
      <p>{claimable?.toString()} stroops claimable</p>
    </div>
  );
}
```

`useClaimableAmount` polls by default; combine with the
[SSE feed](/backend/streams-sse) for push updates.
