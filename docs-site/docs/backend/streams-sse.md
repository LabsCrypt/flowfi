---
title: SSE & WebSocket streams
---

# SSE & WebSocket streams

The dashboard does not poll: the backend pushes indexed events over
Server-Sent Events (WebSocket for the charts pane).

- `GET /api/v1/events/stream` — SSE feed of contract events filtered by the
  caller's wallet. Heartbeat every 25s keeps proxies from idling the
  connection out.
- Reconnects are safe: clients send `Last-Event-ID`, and the server replays
  from the persisted event table rather than from memory.

## Message shape

```json
{
  "id": "1706140800:3",
  "event": "tokens_withdrawn",
  "data": {
    "streamId": "12",
    "recipient": "GBRB...",
    "amount": "45000",
    "timestamp": 1706140800
  }
}
```

Field names match the on-chain event payloads one-to-one, so the same
TypeScript types work client- and chain-side.
