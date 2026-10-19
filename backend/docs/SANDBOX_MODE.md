# Sandbox Mode

Sandbox mode lets developers and API consumers label a request as test traffic. It is intended for safely exploring the FlowFi API and for clearly distinguishing test events from production events.

> **Scope of isolation (important):** Sandbox mode currently labels requests/responses and tags events delivered to sandbox clients with `_sandbox: true`. It does **not** route traffic to a separate database and does not otherwise isolate stored data. Do not rely on sandbox mode for data separation.

## Overview

When sandbox mode is enabled on the server and activated by a client:

- **Request/response labeling** - Responses carry sandbox indicator headers.
- **Event tagging** - Events returned to sandbox clients (REST list and SSE) include `_sandbox: true`.
- **No data isolation** - Sandbox and production requests read and write the same datastore.

## Enabling Sandbox Mode

### Server Configuration

Sandbox mode must be enabled on the server via environment variables:

```bash
# Enable sandbox mode globally (default: false)
SANDBOX_MODE_ENABLED=true

# Optional: configure how sandbox mode is activated
SANDBOX_ALLOW_HEADER=true          # Allow X-Sandbox-Mode header (default: true)
SANDBOX_ALLOW_QUERY_PARAM=true     # Allow ?sandbox=true query param (default: true)
SANDBOX_HEADER_NAME=X-Sandbox-Mode # Custom header name (default: X-Sandbox-Mode)
SANDBOX_QUERY_PARAM_NAME=sandbox   # Custom query param name (default: sandbox)
```

### Client Activation

Once sandbox mode is enabled on the server, clients can activate it in two ways:

#### 1. HTTP Header

```bash
curl -H "X-Sandbox-Mode: true" \
  http://localhost:3001/v1/streams
```

#### 2. Query Parameter

```bash
curl "http://localhost:3001/v1/streams?sandbox=true"
```

## Response Indicators

### Response Headers

All sandbox responses include:

```
X-Sandbox-Mode: true
X-Environment: sandbox
```

Production responses include:

```
X-Environment: production
```

### Event Tagging

Events returned to a sandbox client are tagged with `_sandbox: true` in their `metadata`, for example:

```json
{
  "events": [
    {
      "id": "123",
      "streamId": 42,
      "eventType": "TOPPED_UP",
      "metadata": "{\"newDepositedAmount\":\"5000\",\"_sandbox\":true}"
    }
  ]
}
```

Sandbox SSE (`/v1/events/subscribe?sandbox=true`) connections receive a `connected` frame tagged with `_sandbox: true`, and every subsequent event written to that connection is tagged with `_sandbox: true`. Production clients receive the same events without the tag.

> Sandbox tagging is applied per connection/response. Because events are read from the shared production datastore, a sandbox client observing a stream sees the same underlying events as a production client, merely tagged.

## Data Isolation

None. `SANDBOX_DATABASE_URL` is **not** supported — sandbox mode does not connect to a separate database. All requests use the same `DATABASE_URL`. If you need a genuinely isolated environment, run a separate FlowFi deployment pointed at a different database.

## Usage Examples

### Listing Events in Sandbox Mode

```bash
curl -H "X-Sandbox-Mode: true" \
  "http://localhost:3001/v1/events?address=GABC..."
```

### JavaScript/TypeScript Example

```typescript
const response = await fetch('http://localhost:3001/v1/events?address=GABC...', {
  headers: {
    'X-Sandbox-Mode': 'true',
  },
});

const data = await response.json();
const metadata = JSON.parse(data.events[0]?.metadata ?? '{}');
console.log('Sandbox event:', metadata._sandbox === true); // true
```

### Checking Sandbox Status

```bash
# Health endpoint shows sandbox availability
curl http://localhost:3001/health

# Response includes:
{
  "status": "healthy",
  "sandbox": {
    "enabled": true,
    "available": true
  }
}
```

## Safety Guarantees

### Response Labeling

- ✅ Sandbox responses are marked with response headers
- ✅ Events delivered to sandbox clients include `_sandbox: true`
- ✅ Production clients are unaffected

### Not Guaranteed

- ❌ No separate database
- ❌ No isolation of stored data between sandbox and production

### Error Handling

If sandbox mode is requested but not enabled, the request is treated as a normal production request (sandbox response headers are not set and events are not tagged).

If an endpoint requires sandbox mode and the request is not sandboxed:

```json
{
  "error": "Sandbox mode required",
  "message": "This endpoint requires sandbox mode.",
  "hint": {
    "header": "X-Sandbox-Mode: true",
    "queryParam": "?sandbox=true"
  }
}
```

## Development Setup

### Local Development

1. **Enable sandbox mode** in `.env`:

```bash
SANDBOX_MODE_ENABLED=true
```

2. **Start the server**:

```bash
npm run dev
```

3. **Test with sandbox mode**:

```bash
curl -H "X-Sandbox-Mode: true" "http://localhost:3001/v1/events?address=GABC..."
```

### Production

**Important:** Sandbox mode should be **disabled** in production:

```bash
SANDBOX_MODE_ENABLED=false
```

Or simply omit the environment variable (defaults to disabled).

## Best Practices

### For Developers

1. **Use it for labeling** - Rely on sandbox mode to mark test events, not to isolate data.
2. **Check response headers** - Verify `X-Sandbox-Mode` header in responses.
3. **Expect shared data** - Sandbox requests hit the same database as production.

### For API Consumers

1. **Check sandbox availability** - Query `/health` endpoint first.
2. **Use consistent activation** - Choose header or query param and stick with it.
3. **Verify sandbox mode** - Check response headers and `_sandbox` event metadata.

## Troubleshooting

### Sandbox Mode Not Working

1. **Check server configuration**:
   ```bash
   echo $SANDBOX_MODE_ENABLED  # Should be "true"
   ```

2. **Verify activation method**:
   - Header: `X-Sandbox-Mode: true` (case-sensitive)
   - Query: `?sandbox=true` (case-sensitive)

3. **Check response headers**:
   ```bash
   curl -v -H "X-Sandbox-Mode: true" "http://localhost:3001/v1/events?address=GABC..."
   # Look for: X-Sandbox-Mode: true
   ```

## Related Documentation

- [API Versioning](./API_VERSIONING.md)
- [Architecture Overview](../../docs/ARCHITECTURE.md)
- [Contributing Guide](../../CONTRIBUTING.md)
