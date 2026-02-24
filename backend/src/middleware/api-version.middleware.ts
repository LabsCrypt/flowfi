import type { Request, Response, NextFunction } from 'express';

/**
 * API Version middleware
 * Extracts and validates API version from request
 */
export interface VersionedRequest extends Request {
  apiVersion?: ApiVersion;
}

/**
 * Supported API versions
 */
export const SUPPORTED_VERSIONS = ['v1'] as const;
export type ApiVersion = typeof SUPPORTED_VERSIONS[number];

/**
 * Default API version
 */
export const DEFAULT_VERSION: ApiVersion = 'v1';

/**
 * Middleware to extract API version from URL path
 * Expects routes like /v1/streams, /v2/streams, etc.
 */
export function apiVersionMiddleware(
  req: VersionedRequest,
  res: Response,
  next: NextFunction
): void {
  // Extract version from path (e.g., /v1/streams -> v1)
  const pathParts = req.path.split('/').filter(Boolean);
  const versionMatch = pathParts[0]?.match(/^v(\d+)$/);

  if (versionMatch) {
    const versionString = `v${versionMatch[1]}`;
    
    // Type guard to check if version is supported
    if (SUPPORTED_VERSIONS.includes(versionString as ApiVersion)) {
      const version = versionString as ApiVersion;
      req.apiVersion = version;
      // Remove version from path for route matching
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
      const newPath = '/' + pathParts.slice(1).join('/');
      req.url = newPath + (queryString ? '?' + queryString : '');
      // Note: req.path is read-only, but req.url modification affects routing
    } else {
      res.status(400).json({
        error: 'Unsupported API version',
        message: `API version '${versionString}' is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
        supportedVersions: SUPPORTED_VERSIONS,
      });
      return;
    }
  } else {
    // No version specified, use default
    req.apiVersion = DEFAULT_VERSION;
  }

  next();
}

/**
 * Helper to get API version from request
 */
export function getApiVersion(req: VersionedRequest): ApiVersion {
  return req.apiVersion || DEFAULT_VERSION;
}
