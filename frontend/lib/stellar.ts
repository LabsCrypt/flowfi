import { StrKey } from "@stellar/stellar-sdk";

export function isValidStellarPublicKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return StrKey.isValidEd25519PublicKey(normalized);
}
