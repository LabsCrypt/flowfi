const SENSITIVE_KEY_PATTERNS = [
  /private.?key/i,
  /secret.?key/i,
  /seed/i,
  /mnemonic/i,
  /passphrase/i,
  /password/i,
  /authorization/i,
  /access.?token/i,
  /refresh.?token/i,
  /api.?key/i,
  /signature/i,
  /payload/i,
  /xdr/i,
  /transaction.?hash/i,
  /tx.?hash/i,
  /wallet.?address/i,
  /public.?key/i,
  /address/i,
  /recipient/i,
  /destination/i,
  /sender/i,
  /source/i,
  /payment/i,
  /amount/i,
];

const REDACTED_VALUE = "[REDACTED]";

export function redactDiagnostics<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        result[key] = REDACTED_VALUE;
      } else {
        result[key] = redactValue(nestedValue);
      }
    }

    return result;
  }

  return value;
}

export function createDiagnosticsExport(value: unknown): string {
  return JSON.stringify(redactDiagnostics(value), null, 2);
}
