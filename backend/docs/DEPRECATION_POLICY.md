# API Deprecation Policy

## Overview

This document outlines FlowFi's policy for deprecating and sunsetting API endpoints. Our goal is to provide clear communication and sufficient time for consumers to migrate to new versions.

## Principles

1. **Transparency** - Clear communication about deprecations
2. **Stability** - Maintain backward compatibility within versions
3. **Migration Support** - Provide tools and documentation for migration
4. **Reasonable Timeline** - Give consumers adequate time to adapt

## Deprecation Process

### Phase 1: Announcement (Day 0)

When an endpoint is marked for deprecation:

1. **Add deprecation headers** to responses:
   ```
   X-API-Deprecated: true
   X-API-Sunset-Date: YYYY-MM-DD
   X-API-Migration-Path: /v2/new-endpoint
   ```

2. **Update documentation** with deprecation notice

3. **Add to CHANGELOG.md** with migration guide

4. **Notify consumers** via:
   - GitHub releases
   - API documentation updates
   - Response headers (for programmatic detection)

### Phase 2: Deprecation Period (Minimum 6 Months)

During this period:

- ✅ Endpoint continues to function normally
- ✅ Deprecation headers included in all responses
- ✅ Documentation clearly marked as deprecated
- ✅ Migration guides available
- ❌ No new features added to deprecated endpoint
- ❌ Only critical security fixes applied

### Phase 3: Sunset (After Deprecation Period)

After the sunset date:

- Endpoint returns `410 Gone` status
- Response includes migration information
- Endpoint removed from active codebase
- Documentation archived

## Deprecation Timeline Example

```
Day 0:     Announcement - Headers added, docs updated
Month 1-6: Deprecation period - Endpoint works with warnings
Month 6+:  Sunset - Endpoint returns 410 Gone
```

## Response Format

### During Deprecation Period

**Status Code:** `200 OK` (or original status)

**Headers:**
```
X-API-Deprecated: true
X-API-Sunset-Date: 2024-12-31
X-API-Migration-Path: /v1/streams
```

**Body:** Normal response (unchanged)

### After Sunset

**Status Code:** `410 Gone`

**Headers:**
```
X-API-Deprecated: true
X-API-Sunset-Date: 2024-12-31
X-API-Migration-Path: /v1/streams
```

**Body:**
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

## What Triggers Deprecation?

### Breaking Changes

- Changing request/response structure
- Removing required fields
- Changing field data types
- Removing endpoints
- Changing authentication requirements

### Non-Breaking Changes (No Deprecation Needed)

- Adding optional fields
- Adding new endpoints
- Adding new query parameters
- Adding new response fields
- Performance improvements
- Bug fixes

## Migration Support

### Documentation

- Migration guides for each deprecated endpoint
- Code examples showing old vs new usage
- Common pitfalls and solutions

### Tools

- Health endpoint shows supported versions
- Deprecation headers for programmatic detection
- Clear error messages with migration paths

### Communication

- GitHub releases for major deprecations
- API changelog updates
- Response headers for automatic detection

## Current Deprecations

### Legacy Unversioned Routes

**Endpoints:**
- `/streams` → `/v1/streams`
- `/events` → `/v1/events`

**Status:** Deprecated (as of 2024-02-21)

**Sunset Date:** 2024-12-31

**Migration:**
```javascript
// Before
fetch('/streams')

// After
fetch('/v1/streams')
```

## Best Practices for Consumers

### 1. Monitor Deprecation Headers

```javascript
const response = await fetch('/api/endpoint');
const isDeprecated = response.headers.get('X-API-Deprecated') === 'true';

if (isDeprecated) {
  const sunsetDate = response.headers.get('X-API-Sunset-Date');
  const migrationPath = response.headers.get('X-API-Migration-Path');
  
  console.warn(`Endpoint deprecated. Sunset: ${sunsetDate}`);
  console.info(`Migrate to: ${migrationPath}`);
}
```

### 2. Pin to Specific Versions

Always use versioned endpoints:

```javascript
// ✅ Good - Explicit version
const api = 'https://api.flowfi.io/v1';

// ❌ Bad - No version
const api = 'https://api.flowfi.io';
```

### 3. Plan Migrations Early

- Don't wait until sunset date
- Test new versions in staging
- Update gradually if possible
- Monitor for breaking changes

### 4. Use Health Endpoint

Check supported versions:

```javascript
const health = await fetch('https://api.flowfi.io/health');
const { apiVersions } = await health.json();

if (!apiVersions.supported.includes('v1')) {
  console.error('v1 no longer supported!');
}
```

## Exception Policy

### Critical Security Issues

If a security vulnerability requires immediate removal:

1. Immediate deprecation notice
2. Minimum 30-day grace period (if possible)
3. Emergency communication to all known consumers
4. Extended support for critical enterprise customers (if applicable)

### Breaking Changes Within Version

Breaking changes within a version are **not allowed**. If breaking changes are needed:

1. Create a new version (e.g., v2)
2. Deprecate old version following this policy
3. Provide migration guide

## Version Lifecycle

```
v1 (Current)
  ├─ Active development
  ├─ New features added
  └─ Bug fixes applied

v1 (Deprecated) [Future]
  ├─ No new features
  ├─ Security fixes only
  └─ Migration period

v1 (Sunset) [Future]
  └─ Returns 410 Gone
```

## Questions?

For questions about deprecations or migrations:

- Open an issue on GitHub
- Check the [API Versioning Guide](./API_VERSIONING.md)
- Review the [CHANGELOG.md](../../CHANGELOG.md)
