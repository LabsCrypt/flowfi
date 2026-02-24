/**
 * Sandbox Mode Configuration
 * 
 * Sandbox mode allows test wallets to interact with a fake or mirrored environment
 * without affecting production data.
 */

export interface SandboxConfig {
  enabled: boolean;
  databaseUrl?: string;
  allowHeader: boolean;
  allowQueryParam: boolean;
  headerName: string;
  queryParamName: string;
}

/**
 * Get sandbox configuration from environment variables
 */
export function getSandboxConfig(): SandboxConfig {
  const enabled = process.env.SANDBOX_MODE_ENABLED === 'true';
  const databaseUrl = process.env.SANDBOX_DATABASE_URL;
  
  return {
    enabled,
    databaseUrl: databaseUrl || undefined,
    allowHeader: process.env.SANDBOX_ALLOW_HEADER !== 'false', // Default: true
    allowQueryParam: process.env.SANDBOX_ALLOW_QUERY_PARAM !== 'false', // Default: true
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
