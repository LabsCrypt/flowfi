use soroban_sdk::contracterror;

/// Exhaustive error surface for `StreamContract`.
///
/// Each variant maps to a unique u32 so that clients and indexers can
/// distinguish failures without parsing error messages.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    /// Amount is zero, negative, or otherwise out of range.
    InvalidAmount = 1,
    /// No stream exists for the supplied ID.
    StreamNotFound = 2,
    /// Caller is not authorised to perform this action on the stream.
    Unauthorized = 3,
    /// Operation requires an active stream, but the stream is inactive.
    StreamInactive = 4,
    /// `initialize` has already been called; cannot re-initialize.
    AlreadyInitialized = 5,
    /// Caller is not the protocol admin.
    NotAdmin = 6,
    /// Supplied fee rate exceeds the platform maximum (1 000 bps).
    InvalidFeeRate = 7,
    /// Protocol config has not been initialized yet.
    NotInitialized = 8,
    /// Duration supplied to `create_stream` is zero.
    InvalidDuration = 9,
    /// Supplied token address is not a valid token contract.
    InvalidTokenAddress = 10,
    /// `amount / duration` rounds to zero — the stream would lock tokens but never accrue.
    InvalidRate = 11,
    /// Operation requires an active stream, but the stream is currently paused.
    StreamPaused = 12,
    /// `resume_stream` was called on a stream that is active but not paused.
    StreamNotPaused = 13,
    /// `pause_stream` was called on a stream that is already paused.
    StreamAlreadyPaused = 14,
    /// An amount or timestamp calculation exceeded the range of its type.
    ///
    /// Returned instead of letting `overflow-checks` panic and abort the whole
    /// transaction, so callers get a typed failure they can handle.
    ArithmeticOverflow = 15,
}
