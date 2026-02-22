# Real-Time Event Streaming

FlowFi uses **Server-Sent Events (SSE)** for real-time updates to clients.

## Why SSE over WebSockets?

- **Unidirectional**: Server → Client fits our use case (no client → server events needed)
- **Simpler**: Built on HTTP, automatic reconnection, easier debugging
- **Efficient**: Lower overhead for broadcasting updates
- **Infrastructure-friendly**: Works with standard HTTP/2, proxies, and load balancers

## Endpoint

```
GET /events/subscribe
```

### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `streams` | string[] | Subscribe to specific stream IDs | `?streams=1&streams=2` |
| `users` | string[] | Subscribe to user public keys | `?users=GABC...&users=GDEF...` |
| `all` | boolean | Subscribe to all events | `?all=true` |

## Event Types

| Event | Description | Data |
|-------|-------------|------|
| `stream.created` | New stream created | Stream object |
| `stream.topped_up` | Stream received funds | Stream ID, amount |
| `stream.withdrawn` | Funds withdrawn | Stream ID, amount |
| `stream.cancelled` | Stream cancelled | Stream ID |
| `stream.completed` | Stream completed | Stream ID |

## Client Implementation

### Basic JavaScript

```javascript
const eventSource = new EventSource(
  'http://localhost:3001/events/subscribe?streams=1&streams=2'
);

eventSource.addEventListener('stream.created', (e) => {
  const data = JSON.parse(e.data);
  console.log('New stream:', data);
});

eventSource.addEventListener('stream.withdrawn', (e) => {
  const data = JSON.parse(e.data);
  console.log('Withdrawal:', data);
});

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
};
```

### React Hook

```typescript
import { useEffect, useState } from 'react';

interface StreamEvent {
  type: string;
  data: any;
}

export function useStreamEvents(streamIds: string[]) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    streamIds.forEach(id => params.append('streams', id));
    
    const eventSource = new EventSource(
      `http://localhost:3001/events/subscribe?${params}`
    );

    eventSource.onopen = () => setConnected(true);
    
    eventSource.addEventListener('stream.created', (e) => {
      setEvents(prev => [...prev, { type: 'created', data: JSON.parse(e.data) }]);
    });

    eventSource.addEventListener('stream.withdrawn', (e) => {
      setEvents(prev => [...prev, { type: 'withdrawn', data: JSON.parse(e.data) }]);
    });

    eventSource.onerror = () => setConnected(false);

    return () => eventSource.close();
  }, [streamIds]);

  return { events, connected };
}
```

## Reconnection Strategy

### Browser Default
- Automatic reconnection with exponential backoff
- Initial retry: ~1s
- Max retry: ~30s

### Production Recommendation

```javascript
class SSEClient {
  constructor(url) {
    this.url = url;
    this.retryDelay = 1000;
    this.maxRetryDelay = 30000;
    this.connect();
  }

  connect() {
    this.eventSource = new EventSource(this.url);
    
    this.eventSource.onopen = () => {
      console.log('Connected');
      this.retryDelay = 1000; // Reset on successful connection
    };

    this.eventSource.onerror = () => {
      this.eventSource.close();
      this.reconnect();
    };
  }

  reconnect() {
    setTimeout(() => {
      console.log(`Reconnecting in ${this.retryDelay}ms...`);
      this.connect();
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
    }, this.retryDelay);
  }

  close() {
    this.eventSource.close();
  }
}
```

## Load & Security Considerations

### Connection Limits
- **Default**: No hard limit, constrained by system resources
- **Recommendation**: Monitor with `GET /events/stats` endpoint
- **Scaling**: Use Redis pub/sub for multi-instance deployments

### Memory Management
- Each connection: ~10KB overhead
- 10,000 connections: ~100MB
- Connections auto-cleanup on client disconnect

### Rate Limiting
- SSE endpoint excluded from global rate limiter
- Consider per-IP connection limits in production:

```typescript
// Example middleware
const connectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // 5 connections per IP per minute
  skipSuccessfulRequests: true,
});

router.get('/subscribe', connectionLimiter, subscribe);
```

### DDoS Protection
- Use reverse proxy (nginx/CloudFlare) for connection limits
- Implement authentication for production
- Monitor connection count and set alerts

### Authentication (Production)
```typescript
// Add JWT validation
import { verifyToken } from '../middleware/auth.middleware.js';

router.get('/subscribe', verifyToken, subscribe);
```

### Horizontal Scaling
For multiple backend instances, use Redis:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const subscriber = new Redis(process.env.REDIS_URL);

// Publisher (in stream controller)
redis.publish('stream-events', JSON.stringify({
  event: 'stream.created',
  data: mockStream,
}));

// Subscriber (in SSE service)
subscriber.subscribe('stream-events');
subscriber.on('message', (channel, message) => {
  const { event, data } = JSON.parse(message);
  sseService.broadcast(event, data);
});
```

## Monitoring

Track SSE health with metrics:
- Active connections count
- Events broadcast per second
- Connection duration
- Reconnection rate

## Testing

```bash
# Test connection
curl -N http://localhost:3001/events/subscribe?streams=1

# Test with all events
curl -N http://localhost:3001/events/subscribe?all=true
```
