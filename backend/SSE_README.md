# Server-Sent Events (SSE)

FlowFi uses Server-Sent Events for real-time payment-stream updates. SSE is a
good fit for these server-to-client notifications because it uses standard
HTTP, reconnects automatically, and has less overhead than a bidirectional
WebSocket connection.

## Implementation

The SSE implementation includes:

- subscription filtering by stream, user, or all of the authenticated user's streams;
- automatic connection cleanup and heartbeats;
- per-IP and global connection limits;
- slow-client protection;
- Redis pub/sub for multi-instance delivery, with an in-memory fallback; and
- connection statistics for monitoring.

The relevant implementation lives in:

- [`src/routes/v1/events.routes.ts`](src/routes/v1/events.routes.ts) — authenticated v1 event routes;
- [`src/controllers/sse.controller.ts`](src/controllers/sse.controller.ts) — subscription validation, ownership filtering, and capacity enforcement;
- [`src/services/sse.service.ts`](src/services/sse.service.ts) — connection lifecycle and event delivery;
- [`src/lib/redis.ts`](src/lib/redis.ts) — Redis publisher/subscriber clients; and
- [`src/index.ts`](src/index.ts) — Redis startup and graceful shutdown.

## Authentication and versioning

`GET /v1/events/subscribe` requires a valid JWT in the
`Authorization: Bearer <token>` header. Subscriptions are restricted to streams
owned by the authenticated wallet.

> The old unversioned `GET /events/subscribe` path is deprecated and returns
> HTTP `410 Gone`. Use `/v1/events/subscribe`; it requires JWT authentication.

All state-changing stream endpoints are likewise authenticated and versioned
under `/v1/streams`.

## API endpoints

### Subscribe to events

```http
GET /v1/events/subscribe?streams=1&streams=2
GET /v1/events/subscribe?users=GABC...
GET /v1/events/subscribe?all=true
Authorization: Bearer <JWT>
```

The `all=true` option means all streams visible to the authenticated wallet,
not every stream in the system.

### Connection statistics

```http
GET /v1/events/stats
```

### Authenticated stream operations

```http
POST /v1/streams
POST /v1/streams/:streamId/top-up
POST /v1/streams/:streamId/pause
POST /v1/streams/:streamId/resume
POST /v1/streams/:streamId/withdraw
POST /v1/streams/:streamId/cancel
Authorization: Bearer <JWT>
```

## Event types

- `stream.created`
- `stream.topped_up`
- `stream.withdrawn`
- `stream.cancelled`
- `stream.completed`
- `stream.paused`
- `stream.resumed`

## Quick test

Start the backend:

```bash
cd backend
npm run dev
```

Set a JWT obtained from the v1 authentication flow, then subscribe:

```bash
export TOKEN="<JWT>"

curl -N \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:3001/v1/events/subscribe?all=true"
```

In another terminal, create a stream through the authenticated v1 endpoint.
The `sender` must match the wallet represented by the JWT:

```bash
curl -X POST "http://localhost:3001/v1/streams" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "streamId": "example-stream-1",
    "sender": "GABC...",
    "recipient": "GDEF...",
    "tokenAddress": "CUSDC...",
    "ratePerSecond": "1000000",
    "depositedAmount": "86400000000",
    "startTime": "1708560000"
  }'
```

## Production considerations

### Security

- [x] JWT authentication on `/v1/events/subscribe` — [`src/routes/v1/events.routes.ts`](src/routes/v1/events.routes.ts)
- [x] Per-IP connection limits — [`src/controllers/sse.controller.ts`](src/controllers/sse.controller.ts) and [`src/services/sse.service.ts`](src/services/sse.service.ts)
- [ ] Use a reverse proxy (nginx or Cloudflare) for additional DDoS protection

### Scaling

- [x] Redis pub/sub for multi-instance deployments — [`src/lib/redis.ts`](src/lib/redis.ts) and [`src/services/sse.service.ts`](src/services/sse.service.ts)
- [ ] Monitor connection count and configure alerts
- [ ] Tune connection limits from production traffic data

### Monitoring

- [ ] Track active connections in the production monitoring system
- [ ] Monitor events per second
- [ ] Alert on reconnection spikes

## Further documentation

See [`docs/SSE_IMPLEMENTATION.md`](docs/SSE_IMPLEMENTATION.md) for client
integration, reconnection, scaling, and operational guidance.
