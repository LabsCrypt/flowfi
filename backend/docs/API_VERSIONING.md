# API Versioning Strategy

## Overview

FlowFi API uses **URL-based versioning** to ensure backward compatibility and allow for breaking changes without disrupting existing consumers.

## Versioning Scheme

### URL-Based Versioning

All API endpoints are prefixed with a version identifier:

```
/v1/streams
/v1/events/subscribe
/v1/events/stats
```

**Format:** `/v{version}/{resource}`

### Why URL-Based?

- ✅ **Explicit and discoverable** - Version is visible in the URL
- ✅ **Easy to test** - Simple to change version in browser/Postman
- ✅ **Cache-friendly** - Different versions can be cached separately
- ✅ **Clear migration path** - Easy to see which version you're using
- ✅ **No header dependencies** - Works with any HTTP client

## Supported Versions

| Version | Status | Introduced | Sunset Date |
|---------|--------|------------|-------------|
| `v1` | ✅ Current | 2024-02-21 | TBD |

### Version Lifecycle

1. **Current** - Actively maintained, receives new features and bug fixes
2. **Deprecated** - Still supported but will be sunset on a specific date
3. **Sunset** - No longer available, returns 410 Gone

## Adding New Endpoints

### Rules

1. **All new endpoints MUST be added under a version namespace**
   ```typescript
   // ✅ Correct
   router.post('/v1/streams', createStream);
   
   // ❌ Incorrect
   router.post('/streams', createStream);
   ```

2. **Breaking changes require a new version**
   - Changing request/response structure
   - Removing required fields
   - Changing field types
   - Removing endpoints

3. **Non-breaking changes can be added to existing version**
   - Adding optional fields
   - Adding new endpoints
   - Adding new query parameters
   - Adding new response fields

### Example: Adding a New Endpoint

```typescript
// backend/src/routes/v1/stream.routes.ts
router.get('/:streamId', getStream); // Add to v1
```

### Example: Breaking Change

If you need to change the response structure:

```typescript
// Create v2 routes
// backend/src/routes/v2/stream.routes.ts
router.get('/:streamId', getStreamV2); // New structure

// Update app.ts
import v2Routes from './routes/v2/index.js';
app.use('/v2', v2Routes);
```

## Deprecation Policy

### Deprecation Timeline

1. **Announcement** - Deprecated endpoints return warnings in response headers
2. **Deprecation Period** - Minimum 6 months before sunset
3. **Sunset** - Endpoint returns `410 Gone` with migration information

### Deprecation Headers

Deprecated endpoints include:

```
X-API-Deprecated: true
X-API-Sunset-Date: 2024-12-31
X-API-Migration-Path: /v1/streams
```

### Example Deprecated Response

```json
{
  "error": "Deprecated endpoint",
  "message": "This endpoint has been deprecated. Please use /v1/streams instead.",
  "deprecated": true,
  "migration": {
    "old": "/streams",
    "new": "/v1/streams"
  },
  "sunsetDate": "2024-12-31"
}
```

## Migration Guide

### For API Consumers

1. **Update base URL** to include version:
   ```javascript
   // Before
   const response = await fetch('http://api.flowfi.io/streams');
   
   // After
   const response = await fetch('http://api.flowfi.io/v1/streams');
   ```

2. **Check for deprecation headers**:
   ```javascript
   const isDeprecated = response.headers.get('X-API-Deprecated') === 'true';
   if (isDeprecated) {
     const sunsetDate = response.headers.get('X-API-Sunset-Date');
     console.warn(`Endpoint will be sunset on ${sunsetDate}`);
   }
   ```

3. **Monitor health endpoint** for supported versions:
   ```javascript
   const health = await fetch('http://api.flowfi.io/health');
   const { apiVersions } = await health.json();
   console.log('Supported versions:', apiVersions.supported);
   ```

## Version Detection

### Health Endpoint

The `/health` endpoint includes version information:

```json
{
  "status": "healthy",
  "apiVersions": {
    "supported": ["v1"],
    "default": "v1"
  }
}
```

### Version Middleware

The API version middleware automatically:
- Extracts version from URL path
- Validates version is supported
- Returns 400 for unsupported versions
- Sets default version if none specified

## Best Practices

### For API Developers

1. **Always version new endpoints** - Never add unversioned routes
2. **Document breaking changes** - Update CHANGELOG.md
3. **Provide migration guides** - Help consumers upgrade
4. **Maintain backward compatibility** - Within a version
5. **Test version isolation** - Ensure versions don't interfere

### For API Consumers

1. **Pin to specific version** - Don't rely on default
2. **Monitor deprecation notices** - Check headers and docs
3. **Plan migrations early** - Don't wait until sunset
4. **Test thoroughly** - Before upgrading versions
5. **Use health endpoint** - Check supported versions

## Examples

### Creating a Stream (v1)

```bash
POST /v1/streams
Content-Type: application/json

{
  "sender": "GABC...",
  "recipient": "GDEF...",
  "tokenAddress": "CBCD...",
  "amount": "10000",
  "duration": 86400
}
```

### Subscribing to Events (v1)

```bash
GET /v1/events/subscribe?streams=1&streams=2
Accept: text/event-stream
```

### Unsupported Version

```bash
GET /v2/streams
```

Response:
```json
{
  "error": "Unsupported API version",
  "message": "API version 'v2' is not supported. Supported versions: v1",
  "supportedVersions": ["v1"]
}
```

## Future Considerations

### Version 2 Planning

When planning v2, consider:
- What breaking changes are needed?
- Can they be avoided with optional fields?
- What's the migration complexity for consumers?
- Is a new version necessary or can we extend v1?

### Version Lifecycle Management

- **Current**: v1 (actively maintained)
- **Next**: v2 (when breaking changes are needed)
- **Deprecated**: None currently
- **Sunset**: None currently

## Related Documentation

- [API Documentation](../README.md)
- [Architecture Overview](../../docs/ARCHITECTURE.md)
- [Contributing Guide](../../CONTRIBUTING.md)
