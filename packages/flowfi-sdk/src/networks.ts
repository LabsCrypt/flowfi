/**
 * Network passphrase helpers.
 *
 * Stellar transactions are domain-separated by a network passphrase that is
 * hashed into every signature. A single typo (e.g. a missing space around the
 * `;`) silently produces a valid-looking transaction that fails with an opaque
 * `tx_bad_auth` / hash-mismatch error at submission time — which is painful to
 * debug because the signer is usually blamed first.
 *
 * This module centralises the official passphrases so {@link FlowFiClient} can
 * fail fast with an actionable message when a passphrase is malformed.
 */

/** Canonical identifiers for the networks FlowFi ships against. */
export type KnownNetwork = 'public' | 'testnet' | 'futurenet' | 'standalone';

/** Official network passphrases, exactly as published by SDF. */
export const NETWORK_PASSPHRASES: Record<KnownNetwork, string> = {
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  standalone: 'Standalone Network ; February 2017',
} as const;

export interface NetworkPassphraseValidation {
  /** `true` when the passphrase matches one of the official networks. */
  valid: boolean;
  /** Which official network the passphrase belongs to (when valid). */
  network?: KnownNetwork;
  /** Human-readable hint explaining the failure and how to fix it. */
  hint?: string;
  /** Closest official passphrase when the input looks like a near-miss typo. */
  suggestion?: string;
}

/**
 * Validate a network passphrase against the official Stellar networks.
 *
 * Never throws — callers decide whether an unrecognised passphrase is fatal.
 * The result carries a `hint` (and, for likely typos, a `suggestion`) that is
 * safe to surface directly to developers.
 */
export function validateNetworkPassphrase(
  passphrase: string,
): NetworkPassphraseValidation {
  const known = Object.entries(NETWORK_PASSPHRASES) as Array<
    [KnownNetwork, string]
  >;

  const exact = known.find(([, value]) => value === passphrase);
  if (exact) return { valid: true, network: exact[0] };

  const suggestion = closestPassphrase(passphrase, known);
  const hint = [
    `Unrecognised network passphrase: ${JSON.stringify(passphrase)}.`,
    'FlowFi expects an official Stellar passphrase (mind the spaces around ";", it is case-sensitive):',
    ...known.map(([, value]) => `  • ${value}`),
    suggestion ? `Did you mean: ${JSON.stringify(suggestion)}?` : undefined,
    'If this is an intentional custom/standalone network, pass `allowCustomNetworkPassphrase: true` in the FlowFiClient config.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return { valid: false, hint, suggestion };
}

/** Return the nearest known passphrase for likely typos, else `undefined`. */
function closestPassphrase(
  input: string,
  known: Array<[KnownNetwork, string]>,
): string | undefined {
  const normalised = normalise(input);
  let best: { value: string; distance: number } | undefined;
  const longest = Math.max(...known.map(([, value]) => normalise(value).length));

  for (const [, value] of known) {
    const distance = levenshtein(normalised, normalise(value));
    // Only suggest confidently-close matches (<= 20% of the longest label).
    if (distance <= Math.max(3, Math.floor(longest * 0.2))) {
      if (!best || distance < best.distance) best = { value, distance };
    }
  }
  return best?.value;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Iterative Levenshtein distance (O(n*m) time, O(min) space). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}
