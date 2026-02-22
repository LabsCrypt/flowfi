# SSE Architecture Overview

## System Flow

```
┌─────────────────┐
│  Blockchain     │
│  Indexer        │
│  (Stellar)      │
└────────┬────────┘
         │ Events
         ▼
┌─────────────────────────────────────────────────────────┐
│                    Backend Server                        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stream Controller                                │  │
│  │  - Creates/updates streams                        │  │
│  │  - Calls sseService.broadcast()                   │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
│                 ▼                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  SSE Service                                      │  │
│  │  - Manages client connections                     │  │
│  │  - Filters by subscription                        │  │
│  │  - Broadcasts to matching clients                 │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
└─────────────────┼────────────────────────────────────────┘
                  │ SSE Events
                  ▼
    ┌─────────────────────────────────────┐
    │         Multiple Clients            │
    │                                     │
    │  ┌──────────┐  ┌──────────┐       │
    │  │ Browser  │  │ Browser  │  ...  │
    │  │ Client 1 │  │ Client 2 │       │
    │  └──────────┘  └──────────┘       │
    └─────────────────────────────────────┘
```

## Connection Flow

```
Client                          Server
  │                               │
  │  GET /events/subscribe        │
  │  ?streams=1&streams=2         │
  ├──────────────────────────────>│
  │                               │
  │  200 OK                       │
  │  Content-Type:                │
  │    text/event-stream          │
  │<──────────────────────────────┤
  │                               │
  │  data: {"type":"connected"}   │
  │<──────────────────────────────┤
  │                               │
  │         [Connected]           │
  │                               │
  │  event: stream.created        │
  │  data: {...}                  │
  │<──────────────────────────────┤
  │                               │
  │  event: stream.withdrawn      │
  │  data: {...}                  │
  │<──────────────────────────────┤
  │                               │
  │         [Connection Lost]     │
  │                               │
  │  [Auto Reconnect - 1s]        │
  │                               │
  │  GET /events/subscribe        │
  ├──────────────────────────────>│
  │                               │
  │  200 OK                       │
  │<──────────────────────────────┤
  │                               │
  │         [Reconnected]         │
```

## Subscription Filtering

```
┌─────────────────────────────────────────────────────┐
│                   SSE Service                        │
│                                                      │
│  Client Map:                                         │
│  ┌────────────────────────────────────────────────┐ │
│  │ client-1: { subscriptions: ["1", "2"] }        │ │
│  │ client-2: { subscriptions: ["user:GABC..."] } │ │
│  │ client-3: { subscriptions: ["*"] }             │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Event: stream.created (streamId: "1")              │
│  ↓                                                   │
│  Filter: clients with "1" or "*"                    │
│  ↓                                                   │
│  Broadcast to: client-1, client-3                   │
└─────────────────────────────────────────────────────┘
```

## Horizontal Scaling with Redis

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Backend 1   │      │  Backend 2   │      │  Backend 3   │
│              │      │              │      │              │
│  SSE Service │      │  SSE Service │      │  SSE Service │
│  (10 clients)│      │  (15 clients)│      │  (8 clients) │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │
       │ Publish             │ Subscribe           │
       └─────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Redis Pub/Sub  │
                    │                 │
                    │  Channel:       │
                    │  stream-events  │
                    └─────────────────┘

Flow:
1. Backend 1 receives stream creation
2. Backend 1 publishes to Redis: "stream-events"
3. All backends (1, 2, 3) receive message
4. Each backend broadcasts to its connected clients
5. Total: 33 clients receive the event
```

## Event Broadcasting Logic

```typescript
// Broadcast to specific stream
sseService.broadcastToStream("123", "stream.created", data)
  ↓
  Filter clients: subscription includes "123" or "*"
  ↓
  Send to matching clients

// Broadcast to user
sseService.broadcastToUser("GABC...", "stream.created", data)
  ↓
  Filter clients: subscription includes "user:GABC..." or "*"
  ↓
  Send to matching clients

// Broadcast to all
sseService.broadcast("stream.created", data)
  ↓
  Send to all connected clients
```

## Memory & Performance

```
Single Instance Capacity:

Connections    Memory    CPU (idle)    CPU (1K events/s)
─────────────────────────────────────────────────────────
100            1 MB      <1%           <5%
1,000          10 MB     <1%           ~10%
10,000         100 MB    ~2%           ~30%
50,000         500 MB    ~5%           ~80%

Bottlenecks:
- Network I/O (primary)
- Memory per connection (~10KB)
- Event serialization (JSON.stringify)

Optimization:
- Use Redis for multi-instance
- Implement connection pooling
- Add message batching for high-frequency events
```

## Security Layers

```
┌─────────────────────────────────────────────────┐
│  Reverse Proxy (nginx/CloudFlare)              │
│  - Rate limiting (connections per IP)          │
│  - DDoS protection                              │
│  - SSL termination                              │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│  Backend Middleware                             │
│  - JWT authentication                           │
│  - Connection limits per user                   │
│  - Subscription validation                      │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│  SSE Service                                    │
│  - Client tracking                              │
│  - Auto cleanup on disconnect                   │
│  - Subscription filtering                       │
└─────────────────────────────────────────────────┘
```
