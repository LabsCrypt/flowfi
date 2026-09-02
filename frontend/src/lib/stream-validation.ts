/**
 * stream-validation.ts
 *
 * Canonical validation logic for stream creation.
 * Every entry point (wizard modal, full-page form, dashboard inline form)
 * MUST call these functions to enforce identical rules.
 *
 * Issue: Three divergent implementations had inconsistent validation —
 * only two of three checked recipient format, only one checked wallet balance.
 * This module closes those gaps.
 */

import { hasValidPrecision, validateAmountInput } from "@/utils/amount";
import { isValidStellarPublicKey } from "@/lib/stellar";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DurationUnit =
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "weeks"
  | "months";

export interface StreamFormData {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  durationUnit: DurationUnit;
  descriptionTag?: string;
}

export type StreamFormErrors = Partial<Record<keyof StreamFormData, string>>;

export interface ValidationOptions {
  /**
   * When provided, only validate the fields relevant to the given wizard step:
   *   1 = Template (no field validation)
   *   2 = Recipient
   *   3 = Token
   *   4 = Amount
   *   5 = Schedule / Duration
   *
   * When omitted, validate ALL fields at once (flat-form mode).
   */
  step?: number;
  /** Display-formatted wallet balance for the selected token (e.g. "1000.5") */
  walletBalance?: string | null;
}

// ─── Individual field validators ──────────────────────────────────────────────

export function validateRecipient(
  recipient: string,
): string | null {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return "Recipient address is required";
  }
  if (!isValidStellarPublicKey(trimmed)) {
    return "Invalid Stellar public key format";
  }
  return null;
}

export function validateToken(token: string): string | null {
  if (!token || !token.trim()) {
    return "Please select a token";
  }
  return null;
}

export function validateAmount(
  amount: string,
  walletBalance?: string | null,
): string | null {
  const trimmed = amount.trim();
  if (!trimmed) {
    return "Amount is required";
  }

  const parsed = parseFloat(trimmed);
  if (isNaN(parsed) || parsed <= 0) {
    return "Amount must be a positive number";
  }

  if (!hasValidPrecision(trimmed, 7)) {
    return "Amount exceeds maximum precision (7 decimal places)";
  }

  // Use the richer validateAmountInput for extra safety
  const deepCheck = validateAmountInput(trimmed, 7);
  if (deepCheck) {
    return deepCheck;
  }

  // Wallet balance check — applied uniformly across all entry points
  if (walletBalance) {
    const available = parseFloat(walletBalance);
    if (!isNaN(available) && parsed > available) {
      return "Amount exceeds wallet balance";
    }
  }

  return null;
}

export function validateDuration(duration: string): string | null {
  const trimmed = duration.trim();
  if (!trimmed) {
    return "Duration is required";
  }
  const parsed = parseFloat(trimmed);
  if (isNaN(parsed) || parsed <= 0) {
    return "Duration must be a positive number";
  }
  return null;
}

// ─── Composite validator ──────────────────────────────────────────────────────

/**
 * Validate stream form fields.
 *
 * In **step mode** (`options.step` is set) only the fields for the given wizard
 * step are checked.  In **flat mode** (no step) every field is validated.
 *
 * @returns An object of field→error entries.  Empty object = valid.
 */
export function validateStreamForm(
  data: StreamFormData,
  options: ValidationOptions = {},
): StreamFormErrors {
  const { step, walletBalance } = options;
  const errors: StreamFormErrors = {};

  const shouldValidate = (
    fieldStep: number,
  ): boolean => (step === undefined || step === fieldStep);

  // Step 1 = Template selection — no field validation required
  // Step 2 = Recipient
  if (shouldValidate(2)) {
    const recipientError = validateRecipient(data.recipient);
    if (recipientError) errors.recipient = recipientError;
  }

  // Step 3 = Token
  if (shouldValidate(3)) {
    const tokenError = validateToken(data.token);
    if (tokenError) errors.token = tokenError;
  }

  // Step 4 = Amount
  if (shouldValidate(4)) {
    const amountError = validateAmount(data.amount, walletBalance);
    if (amountError) errors.amount = amountError;
  }

  // Step 5 = Duration / Schedule
  if (shouldValidate(5)) {
    const durationError = validateDuration(data.duration);
    if (durationError) errors.duration = durationError;
  }

  return errors;
}
