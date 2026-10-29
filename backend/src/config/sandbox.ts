/**
 * Sandbox Mode Configuration
 *
 * Sandbox mode lets a client flag a request as test traffic. When enabled,
 * sandbox requests/responses are labelled (`X-Sandbox-Mode` / `X-Environment`
 * headers) and events returned to sandbox clients are tagged with
 * `_sandbox: true` metadata so they can be told apart from production data.
 *
 * It does NOT route requests to a separate datastore or perform any other
 * data isolation — see the corrected docs in `docs/SANDBOX_MODE.md`.
 */

export interface SandboxConfig {
  enabled: boolean;
  allowHeader: boolean;
  allowQueryParam: boolean;
  headerName: string;
  queryParamName: string;
}

/**
 * Helper function to strictly validate boolean environment variables.
 * 
 * Accepted values:
 * - 'true': Enables the setting
 * - 'false': Disables the setting
 * - undefined: Omitted; uses the specified default value
 * 
 * Invalid values (e.g. 'TRUE', 'yes', '1', '', etc.) throw a configuration error.
 */
function parseBooleanEnv(varName: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${varName} has invalid value '${value}'. Expected one of: 'true', 'false'.`);
}

/**
 * Get sandbox configuration from environment variables
 * 
 * Accepted values for boolean environment variables:
 * - SANDBOX_MODE_ENABLED: 'true' | 'false' (default: false)
 * - SANDBOX_ALLOW_HEADER: 'true' | 'false' (default: true)
 * - SANDBOX_ALLOW_QUERY_PARAM: 'true' | 'false' (default: true)
 */
export function getSandboxConfig(): SandboxConfig {
  const enabled = parseBooleanEnv('SANDBOX_MODE_ENABLED', process.env.SANDBOX_MODE_ENABLED, false);

  return {
    enabled,
    allowHeader: parseBooleanEnv('SANDBOX_ALLOW_HEADER', process.env.SANDBOX_ALLOW_HEADER, true),
    allowQueryParam: parseBooleanEnv('SANDBOX_ALLOW_QUERY_PARAM', process.env.SANDBOX_ALLOW_QUERY_PARAM, true),
    headerName: process.env.SANDBOX_HEADER_NAME || 'X-Sandbox-Mode',
    queryParamName: process.env.SANDBOX_QUERY_PARAM_NAME || 'sandbox',
  };
}

/**
 * Check if sandbox mode is globally enabled
 */
export function isSandboxModeEnabled(): boolean {
  return getSandboxConfig().enabled;
}

