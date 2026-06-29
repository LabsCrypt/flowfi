export function isValidStellarPublicKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  // Lightweight Ed25519 strkey check: Starts with 'G', 56 chars total, Base32 characters
  return /^G[A-Z2-7]{55}$/.test(normalized);
}
