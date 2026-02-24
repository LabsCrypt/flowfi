# Sandbox Mode

Sandbox mode allows developers and new users to experiment with FlowFi API without touching real funds or affecting production data.

## Overview

When sandbox mode is enabled, all API requests are routed to a separate, isolated environment:
- **Separate database** - Complete data isolation from production
- **Clear labeling** - All responses include sandbox indicators
- **Safe testing** - No risk of affecting production data or real funds

## Enabling Sandbox Mode

### Server Configuration

Sandbox mode must be enabled on the server via environment variables:

```bash
# Enable sandbox mode globally
SANDBOX_MODE_ENABLED=true

# Optional: Use a separate database for sandbox
SANDBOX_DATABASE_URL=file:./sandbox.db

# Optional: Configure how sandbox mode is activated
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

### Response Body

Sandbox responses include a `_sandbox` metadata object:

```json
{
  "id": "123",
  "status": "pending",
  "sender": "GABC...",
  "_sandbox": {
    "mode": true,
    "warning": "This is sandbox data and does not affect production",
    "timestamp": "2024-02-21T14:30:00.000Z"
  }
}
```

## Database Isolation

### Default Behavior

If `SANDBOX_DATABASE_URL` is not set, sandbox mode uses:
- SQLite: `{DATABASE_URL}_sandbox`
- Example: If `DATABASE_URL=file:./dev.db`, sandbox uses `file:./dev.db_sandbox`

### Custom Database

Set `SANDBOX_DATABASE_URL` to use a completely separate database:

```bash
# Use a different SQLite file
SANDBOX_DATABASE_URL=file:./sandbox.db

# Or use a different PostgreSQL database
SANDBOX_DATABASE_URL=postgresql://user:pass@localhost:5432/flowfi_sandbox
```

## Usage Examples

### Creating a Stream in Sandbox Mode

```bash
# Using header
curl -X POST http://localhost:3001/v1/streams \
  -H "Content-Type: application/json" \
  -H "X-Sandbox-Mode: true" \
  -d '{
    "sender": "GABC...",
    "recipient": "GDEF...",
    "tokenAddress": "CBCD...",
    "amount": "10000",
    "duration": 86400
  }'

# Using query parameter
curl -X POST "http://localhost:3001/v1/streams?sandbox=true" \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "GABC...",
    "recipient": "GDEF...",
    "tokenAddress": "CBCD...",
    "amount": "10000",
    "duration": 86400
  }'
```

### JavaScript/TypeScript Example

```typescript
// Using fetch with header
const response = await fetch('http://localhost:3001/v1/streams', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Sandbox-Mode': 'true',
  },
  body: JSON.stringify({
    sender: 'GABC...',
    recipient: 'GDEF...',
    tokenAddress: 'CBCD...',
    amount: '10000',
    duration: 86400,
  }),
});

const data = await response.json();
console.log('Sandbox mode:', data._sandbox?.mode); // true
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

### Data Isolation

- ✅ Sandbox data is stored in a separate database
- ✅ Production database is never accessed in sandbox mode
- ✅ No cross-contamination between sandbox and production

### Response Labeling

- ✅ All sandbox responses are clearly marked
- ✅ Response headers indicate sandbox mode
- ✅ Response body includes `_sandbox` metadata

### Error Handling

If sandbox mode is requested but not enabled:

```json
{
  "error": "Sandbox mode not available",
  "message": "Sandbox mode is not enabled on this server."
}
```

If sandbox mode is required but not activated:

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
SANDBOX_DATABASE_URL=file:./sandbox.db
```

2. **Run migrations** for sandbox database (if using separate DB):

```bash
# Sandbox database will be created automatically on first use
# Or run migrations manually if needed
```

3. **Start the server**:

```bash
npm run dev
```

4. **Test with sandbox mode**:

```bash
curl -H "X-Sandbox-Mode: true" http://localhost:3001/v1/streams
```

### Production

**Important:** Sandbox mode should be **disabled** in production:

```bash
SANDBOX_MODE_ENABLED=false
```

Or simply omit the environment variable (defaults to disabled).

## Best Practices

### For Developers

1. **Always test in sandbox first** - Verify functionality before production
2. **Use separate database** - Set `SANDBOX_DATABASE_URL` for complete isolation
3. **Check response headers** - Verify `X-Sandbox-Mode` header in responses
4. **Monitor sandbox data** - Use Prisma Studio or similar to inspect sandbox database

### For API Consumers

1. **Check sandbox availability** - Query `/health` endpoint first
2. **Use consistent activation** - Choose header or query param and stick with it
3. **Verify sandbox mode** - Check response headers and `_sandbox` metadata
4. **Don't mix modes** - Don't switch between sandbox and production in the same session

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
   curl -v -H "X-Sandbox-Mode: true" http://localhost:3001/v1/streams
   # Look for: X-Sandbox-Mode: true
   ```

### Database Issues

If sandbox database doesn't exist:
- It will be created automatically on first use
- Ensure write permissions in the database directory
- Check `SANDBOX_DATABASE_URL` is correct

## Related Documentation

- [API Versioning](./API_VERSIONING.md)
- [Architecture Overview](../../docs/ARCHITECTURE.md)
- [Contributing Guide](../../CONTRIBUTING.md)
