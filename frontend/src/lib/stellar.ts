import { StrKey } from "@stellar/stellar-sdk/base";

/**
 * Validate a Stellar Ed25519 public key ("G...") using the full StrKey
 * checksum, rather than only prefix/length heuristics.
 *
 * `StrKey.isValidEd25519PublicKey` verifies the CRC16-XModem checksum and
 * rejects malformed keys as well as muxed (M...), contract (C...),
 * secret (S...) and other StrKey types that the stream contract does not
 * accept. Surrounding whitespace is trimmed before validation.
 */
export function isValidStellarPublicKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return StrKey.isValidEd25519PublicKey(normalized);
}
