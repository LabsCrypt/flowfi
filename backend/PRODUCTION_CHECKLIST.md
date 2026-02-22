# Production Deployment Checklist

## Pre-Deployment

### Security
- [ ] Add JWT authentication to `/events/subscribe`
  ```typescript
  import { verifyToken } from './middleware/auth.middleware.js';
  router.get('/subscribe', verifyToken, subscribe);
  ```

- [ ] Implement per-IP connection limits
  ```typescript
  const connectionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5, // 5 connections per IP per minute
  });
  router.get('/subscribe', connectionLimiter, subscribe);
  ```

- [ ] Configure CORS for production domains
  ```typescript
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true,
  }));
  ```

- [ ] Add request validation for subscription parameters
  - ✅ Already implemented with Zod

### Infrastructure

- [ ] Set up reverse proxy (nginx/CloudFlare)
  ```nginx
  location /events/subscribe {
    proxy_pass http://backend:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;
  }
  ```

- [ ] Configure Redis for horizontal scaling
  ```typescript
  // Install: npm install ioredis
  import Redis from 'ioredis';
  
  const redis = new Redis(process.env.REDIS_URL);
  const subscriber = new Redis(process.env.REDIS_URL);
  
  subscriber.subscribe('stream-events');
  subscriber.on('message', (channel, message) => {
    const { event, data } = JSON.parse(message);
    sseService.broadcast(event, data);
  });
  ```

- [ ] Set up load balancer with sticky sessions (if not using Redis)

### Monitoring

- [ ] Add Prometheus metrics
  ```typescript
  import { register, Counter, Gauge } from 'prom-client';
  
  const activeConnections = new Gauge({
    name: 'sse_active_connections',
    help: 'Number of active SSE connections',
  });
  
  const eventsPublished = new Counter({
    name: 'sse_events_published_total',
    help: 'Total number of SSE events published',
    labelNames: ['event_type'],
  });
  ```

- [ ] Set up alerts for:
  - Connection count > threshold
  - High reconnection rate
  - Memory usage > 80%
  - Event broadcast failures

- [ ] Add logging for:
  - Connection/disconnection events
  - Event broadcast metrics
  - Error rates

### Performance

- [ ] Set connection limits
  ```typescript
  const MAX_CONNECTIONS = 10000;
  
  if (sseService.getClientCount() >= MAX_CONNECTIONS) {
    return res.status(503).json({
      message: 'Server at capacity, please try again later',
    });
  }
  ```

- [ ] Implement message batching for high-frequency events
  ```typescript
  class SSEService {
    private batchQueue: Map<string, any[]> = new Map();
    private batchInterval = 100; // ms
    
    broadcastBatched(event: string, data: any) {
      // Batch events and send every 100ms
    }
  }
  ```

- [ ] Add connection timeout
  ```typescript
  const HEARTBEAT_INTERVAL = 30000; // 30s
  
  setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL);
  ```

## Deployment

### Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=3001
REDIS_URL=redis://redis:6379
ALLOWED_ORIGINS=https://flowfi.app,https://app.flowfi.app
JWT_SECRET=<your-secret>
MAX_SSE_CONNECTIONS=10000
SSE_HEARTBEAT_INTERVAL=30000
```

### Docker Compose

```yaml
services:
  backend:
    build: ./backend
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - backend

volumes:
  redis-data:
```

### Kubernetes (Optional)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flowfi-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: flowfi-backend
  template:
    metadata:
      labels:
        app: flowfi-backend
    spec:
      containers:
      - name: backend
        image: flowfi/backend:latest
        env:
        - name: REDIS_URL
          value: redis://redis-service:6379
        resources:
          limits:
            memory: "512Mi"
            cpu: "500m"
          requests:
            memory: "256Mi"
            cpu: "250m"
```

## Post-Deployment

### Testing

- [ ] Test SSE connection from production domain
  ```bash
  curl -N https://api.flowfi.app/events/subscribe?all=true
  ```

- [ ] Verify reconnection behavior
  - Kill connection and check auto-reconnect
  - Verify exponential backoff

- [ ] Load test with realistic traffic
  ```bash
  # Use k6 or similar
  import http from 'k6/http';
  
  export default function() {
    http.get('https://api.flowfi.app/events/subscribe?all=true');
  }
  ```

- [ ] Test horizontal scaling
  - Deploy multiple instances
  - Verify events reach all clients
  - Check Redis pub/sub working

### Monitoring

- [ ] Set up dashboards for:
  - Active connections per instance
  - Events published per second
  - Connection duration distribution
  - Reconnection rate
  - Memory usage per instance

- [ ] Configure alerts:
  - Connection count > 8000 (warning)
  - Connection count > 9500 (critical)
  - Reconnection rate > 10/min (warning)
  - Memory > 80% (warning)
  - Event broadcast latency > 100ms (warning)

### Documentation

- [ ] Update API documentation with production URLs
- [ ] Document rate limits and connection policies
- [ ] Create runbook for common issues:
  - High connection count
  - Redis connection failures
  - Memory leaks
  - Event broadcast delays

## Rollback Plan

If issues occur:

1. **Immediate**: Route traffic to old version
   ```bash
   kubectl rollout undo deployment/flowfi-backend
   ```

2. **Investigate**: Check logs and metrics
   ```bash
   kubectl logs -f deployment/flowfi-backend
   ```

3. **Fix**: Address issues in staging
4. **Redeploy**: With fixes and additional monitoring

## Success Metrics

After 24 hours:
- [ ] 99.9% uptime
- [ ] < 1% reconnection rate
- [ ] < 100ms event broadcast latency (p95)
- [ ] < 500MB memory per instance
- [ ] No connection limit errors
- [ ] No Redis connection failures

## Maintenance

### Weekly
- [ ] Review connection metrics
- [ ] Check for memory leaks
- [ ] Review error logs

### Monthly
- [ ] Load test with peak traffic + 50%
- [ ] Review and optimize Redis configuration
- [ ] Update dependencies

### Quarterly
- [ ] Capacity planning review
- [ ] Security audit
- [ ] Performance optimization review
