from __future__ import annotations

from typing import Optional


class FlowFiError(Exception):
    """Base exception for all FlowFi SDK errors."""


class FlowFiContractError(FlowFiError):
    """Raised when a contract call fails.

    Attributes:
        code: The numeric StreamError code from the contract.
        message: Human-readable error description.
    """

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"StreamError {code}: {message}")


class FlowFiConfigError(FlowFiError):
    """Raised when the SDK is misconfigured."""


class FlowFiSimulationError(FlowFiError):
    """Raised when a transaction simulation fails."""


class FlowFiNetworkError(FlowFiError):
    """Raised when RPC or network communication fails."""


class FlowFiRateLimitExceeded(FlowFiError):
    """Raised when the RPC rate limit is hit."""


class FlowFiPollRetryExhausted(FlowFiError):
    """Raised when the transaction poll retry budget is exhausted."""


# Mapping from stellar-sdk error codes to our FlowFiContractError codes.
# These mirror the contract's StreamError enum.
KNOWN_CONTRACT_ERRORS: dict[int, str] = {
    0: "ok",
    1: "invalid_amount",
    2: "invalid_duration",
    3: "invalid_rate",
    4: "unauthorized",
    5: "stream_not_active",
    6: "stream_paused",
    7: "arithmetic_overflow",
    8: "withdrawn_exceeds_deposited",
    9: "protocol_paused",
    10: "stream_already_paused",
    11: "stream_not_paused",
    12: "stream_not_active_or_paused",
    13: "step_tranches_top_ups_not_supported",
    14: "hybrid_cliff_cannot_be_negative",
    15: "rate_per_second_cannot_be_zero",
    16: "invalid_cliff",
    17: "cliff_time_after_end",
    18: "zero_withdrawal",
    19: "cannot_cancel_completed_stream",
    20: "cannot_resume_non_paused_stream",
    21: "cannot_resume_cancelled_stream",
    22: "internal_error",
    100: "operation_failed",
    101: "timed_out",
    102: "rate_limited",
    103: "tx_rejected",
    200: "rate_limited",
}