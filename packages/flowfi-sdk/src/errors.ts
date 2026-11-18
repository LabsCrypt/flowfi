/**
 * Soroban contract error mapping and parsing utilities for FlowFi.
 */

export interface ContractErrorDefinition {
  code: number;
  name: string;
  message: string;
}

/**
 * Mapping of numeric Soroban contract error codes to typed names and descriptions.
 * Corresponds to `StreamError` in `contracts/stream_contract/src/errors.rs`.
 */
export const CONTRACT_ERRORS: Record<number, ContractErrorDefinition> = {
  1: { code: 1, name: 'InvalidAmount', message: 'Amount is zero, negative, or otherwise out of range.' },
  2: { code: 2, name: 'StreamNotFound', message: 'No stream exists for the supplied ID.' },
  3: { code: 3, name: 'Unauthorized', message: 'Caller is not authorised to perform this action on the stream.' },
  4: { code: 4, name: 'StreamInactive', message: 'Operation requires an active stream, but the stream is inactive.' },
  5: { code: 5, name: 'AlreadyInitialized', message: '`initialize` has already been called; cannot re-initialize.' },
  6: { code: 6, name: 'NotAdmin', message: 'Caller is not the protocol admin.' },
  7: { code: 7, name: 'InvalidFeeRate', message: 'Supplied fee rate exceeds the platform maximum (1 000 bps).' },
  8: { code: 8, name: 'NotInitialized', message: 'Protocol config has not been initialized yet.' },
  9: { code: 9, name: 'InvalidDuration', message: 'Duration supplied to `create_stream` is zero.' },
  10: { code: 10, name: 'InvalidTokenAddress', message: 'Supplied token address is not a valid token contract.' },
  11: { code: 11, name: 'InvalidRate', message: '`amount / duration` rounds to zero — the stream would lock tokens but never accrue.' },
  12: { code: 12, name: 'StreamPaused', message: 'Operation requires an active stream, but the stream is currently paused.' },
  13: { code: 13, name: 'StreamNotPaused', message: '`resume_stream` was called on a stream that is active but not paused.' },
  14: { code: 14, name: 'StreamAlreadyPaused', message: '`pause_stream` was called on a stream that is already paused.' },
  15: { code: 15, name: 'ProtocolPaused', message: 'The protocol circuit breaker is engaged; token-in operations are halted.' },
  16: { code: 16, name: 'EmptyVestingSchedule', message: 'A step-tranche schedule declared no steps.' },
  17: { code: 17, name: 'TooManyVestingSteps', message: 'A step-tranche schedule declares more than `MAX_VESTING_STEPS` steps.' },
  18: { code: 18, name: 'NonMonotonicVestingSteps', message: 'Step unlock times are not strictly monotonically increasing.' },
  19: { code: 19, name: 'InvalidVestingStepAmount', message: 'A step\'s `unlock_amount` is zero or negative.' },
  20: { code: 20, name: 'VestingStepTotalMismatch', message: 'Step amounts do not sum to the stream\'s deposited amount.' },
  21: { code: 21, name: 'VestingStepBeforeStart', message: 'A vesting step unlocks at or before the stream\'s start time.' },
  22: { code: 22, name: 'InvalidCliffParameters', message: 'Cliff time is not strictly after the stream start, or the cliff amount leaves no room for the linear tail.' },
  23: { code: 23, name: 'BatchTooLarge', message: '`batch_withdraw` received more than `MAX_BATCH_WITHDRAW` stream IDs.' },
  24: { code: 24, name: 'NotGuardian', message: 'Caller is not the protocol admin and not the emergency guardian.' },
  25: { code: 25, name: 'UnsupportedMigration', message: '`migrate` was asked to move to a version this contract cannot reach.' },
  26: { code: 26, name: 'StateVersionTooNew', message: 'The on-chain state is already at a version newer than this contract.' },
  27: { code: 27, name: 'TopUpUnsupported', message: '`top_up_stream` was called on a step-tranche stream.' },
  28: { code: 28, name: 'RateModificationUnsupported', message: 'Rate modification attempted on unsupported schedule type.' },
  29: { code: 29, name: 'InvalidNewRate', message: 'New rate is invalid (e.g., zero or too small).' },
  30: { code: 30, name: 'DisputeNotSupported', message: 'Dispute operation attempted on non-disputable stream.' },
  31: { code: 31, name: 'NoActiveDispute', message: 'Stream does not have an active dispute.' },
  32: { code: 32, name: 'NotArbiter', message: 'Caller is not the arbiter for this stream\'s dispute.' },
  33: { code: 33, name: 'AllowanceLocked', message: 'Allowance-based stream operation failed.' },
  34: { code: 34, name: 'ArithmeticOverflow', message: 'A checked arithmetic operation overflowed the `i128` or `u64` range.' },
  35: { code: 35, name: 'StreamNotActive', message: '`resume_stream` was called on a stream that is no longer active.' },
  36: { code: 36, name: 'StreamStillActive', message: '`close_stream` was called on a stream that is still active or still holds unwithdrawn funds.' },
  37: { code: 37, name: 'InvalidMilestone', message: 'A conditional milestone id is duplicated within one stream, is referenced that does not exist, or the milestone list is empty.' },
  38: { code: 38, name: 'OraclePriceUnavailable', message: 'The oracle returned no price for the asset.' },
  39: { code: 39, name: 'OraclePriceStale', message: 'The oracle price is older than `ORACLE_PRICE_MAX_AGE_SECS`.' },
  40: { code: 40, name: 'ConditionNotMet', message: 'The milestone\'s condition has not been met, so nothing unlocked.' },
  41: { code: 41, name: 'MilestoneAlreadyUnlocked', message: 'The milestone was already unlocked and cannot unlock again.' },
  42: { code: 42, name: 'InvalidAttestation', message: 'The attestation id was already used to unlock a milestone on this stream, or the attestation signer is not the milestone\'s oracle.' },
  43: { code: 43, name: 'MilestoneCallerUnauthorized', message: 'The caller is not authorized to unlock this milestone.' },
  44: { code: 44, name: 'TooManyMilestones', message: 'The conditional milestone list would exceed `MAX_CONDITIONAL_MILESTONES`.' },
  45: { code: 45, name: 'FeeExceedsMaximum', message: 'Protocol fee exceeds the maximum allowed cap (max 100 bps / 1%).' },
  46: { code: 46, name: 'InvalidFeeSplit', message: 'The sum of recipient shares in a fee split does not equal 10_000 bps.' },
  47: { code: 47, name: 'DeadlineExpired', message: 'The deadline has expired for a cross-asset withdrawal.' },
  48: { code: 48, name: 'InsufficientOutput', message: 'The DEX swap returned less than the caller\'s minimum output amount.' },
};

/**
 * Parses Soroban diagnostic error strings like `"HostError: Error(Contract, #4)"` or
 * error objects, returning the matching error metadata or `null` if no contract error is present.
 */
export function parseContractError(rawError: unknown): ContractErrorDefinition | null {
  if (rawError === null || rawError === undefined) {
    return null;
  }

  let errorStr = '';
  if (typeof rawError === 'string') {
    errorStr = rawError;
  } else if (rawError instanceof Error) {
    errorStr = `${rawError.message} ${rawError.stack ?? ''}`;
  } else if (typeof rawError === 'object') {
    errorStr = JSON.stringify(rawError);
  } else {
    errorStr = String(rawError);
  }

  const match = errorStr.match(/Error\(Contract,\s*#?(\d+)\)/) || errorStr.match(/ContractError\(#?(\d+)\)/);
  if (!match) {
    return null;
  }

  const code = parseInt(match[1], 10);
  const known = CONTRACT_ERRORS[code];
  if (known) {
    return { ...known };
  }

  return {
    code,
    name: `ContractError_${code}`,
    message: `Soroban contract error #${code}`,
  };
}
