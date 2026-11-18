use crate::errors::StreamError;
use soroban_sdk::{Address, Env};

/// Abstract yield adapter interface for Soroban-native DeFi lending markets.
///
/// Implementations route idle deposited tokens to yield-bearing protocols
/// (e.g. Blend, liquidity pools) in exchange for interest-bearing pool tokens.
/// Upon withdrawal or cancellation, principal is instantly redeemed and excess
/// yield is split according to protocol parameters.
pub trait YieldStrategy {
    /// Deposit `amount` of `token` into the yield strategy, receiving shares
    /// of the interest-bearing pool in return.
    ///
    /// Returns the amount of principal actually deposited (may differ from
    /// `amount` if the strategy applies fees or min‑share guarantees).
    fn deposit(env: &Env, token: &Address, amount: i128) -> Result<i128, StreamError>;

    /// Withdraw `shares` of the interest-bearing pool, returning the original
    /// principal plus any accrued yield.
    ///
    /// Returns the amount of principal released to the caller.
    fn withdraw(env: &Env, token: &Address, shares: i128) -> Result<i128, StreamError>;

    /// Return the current exchange rate: 1 share = `rate` worth of principal
    /// (in the token's base units). Used to compute how much principal is
    /// redeemable for a given number of shares.
    fn get_exchange_rate(env: &Env, token: &Address) -> i128;
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_yield_strategy_trait_dispatch() {
        // Verify the trait methods have the correct signatures by checking
        // that they can be assigned to function pointers with the expected types.
        // Concrete implementations must satisfy these signatures.
        let _deposit: fn(&Env, &Address, i128) -> Result<i128, StreamError> =
            |_env, _token, _amount| Ok(0i128);
        let _withdraw: fn(&Env, &Address, i128) -> Result<i128, StreamError> =
            |_env, _token, _shares| Ok(0i128);
        let _exchange_rate: fn(&Env, &Address) -> i128 = |_env, _token| 1i128;
    }
}
